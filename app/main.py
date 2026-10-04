# ============================================================
# CONFIGURATION
# ============================================================
# PURPOSE: Read settings from environment variables. No secret lives in code.
# INPUT: GROQ_API_KEY, GROQ_MODEL, DATABASE_URL, COOKIE_SECURE
# OUTPUT: module-level settings.
# FAILURE CASES: a missing GROQ_API_KEY is reported when an AI route runs,
#                so the app still starts and users can still sign in.

import hashlib
import json
import logging
import os
import secrets
import time
from datetime import datetime, timedelta
from typing import List, Optional, get_args, get_origin

import bcrypt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_groq import ChatGroq
from pydantic import BaseModel, EmailStr, Field, ValidationError
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, declarative_base, sessionmaker

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("business_builder")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./business_builder.db")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").lower() == "true"

COOKIE_NAME = "session"
SESSION_DAYS = 7
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES = 5
MAX_TEXT = 4000  # longest free-text field we accept from a user


# ============================================================
# ERRORS
# ============================================================
# PURPOSE: One error type that the frontend reads the same way every time.
# OUTPUT: {"success": false, "error": {"type", "message"}}

class AppError(Exception):
    def __init__(self, error_type: str, message: str, status: int = 500):
        self.error_type = error_type
        self.message = message
        self.status = status


# ============================================================
# DATABASE CONFIGURATION
# ============================================================
# PURPOSE: Connect to Neon PostgreSQL (or local SQLite) and define the tables.
# FAILURE CASES: wrong URL or sleeping Neon -> SQLAlchemyError -> DB_ERROR (503).

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    password_hash = Column(String(100), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class UserSession(Base):
    __tablename__ = "user_sessions"
    token_hash = Column(String(64), primary_key=True)  # only a hash of the token is stored
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    expires_at = Column(DateTime, nullable=False)


class BusinessProject(Base):
    __tablename__ = "business_projects"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    profile_json = Column(Text, nullable=False)
    # Each AI result is stored as JSON under its own key: opportunities, market,
    # pain_points, gaps, plan, financials, globalization, execution.
    results_json = Column(Text, nullable=False, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("business_projects.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(10), nullable=False)  # "user" or "assistant"
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


def get_db():
    """One database session per request, closed afterwards."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ============================================================
# SCHEMAS (Pydantic)
# ============================================================
# PURPOSE: Validate user input and AI output. Never trust raw LLM text.
# FAILURE CASES: bad email, short password, missing or oversized fields -> 422.

class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)  # bcrypt uses at most 72 bytes


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=72)


class BusinessProfile(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    skills: str = Field(min_length=2, max_length=MAX_TEXT)
    interests: str = Field(default="", max_length=MAX_TEXT)
    budget: float = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    country: str = Field(min_length=2, max_length=100)
    city: str = Field(default="", max_length=100)
    industry: str = Field(default="", max_length=200)
    goals: str = Field(default="", max_length=MAX_TEXT)
    desired_income: float = Field(default=0, ge=0)
    online_or_offline: str = Field(default="either", max_length=20)


class Opportunity(BaseModel):
    business_name: str
    concept: str
    problem: str
    target_customer: str
    solution: str
    revenue_model: str
    startup_requirements: str
    operating_requirements: str = ""
    required_skills: List[str] = []
    required_technology: List[str] = []
    risks: List[str] = []
    advantages: List[str] = []
    estimated_startup_cost: str = ""
    estimated_monthly_cost: str = ""
    implementation_difficulty: str
    assumptions: List[str] = []


class OpportunityList(BaseModel):
    opportunities: List[Opportunity]


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_TEXT)


class ProjectCreate(BaseModel):
    profile: BusinessProfile


# ============================================================
# AUTH: PASSWORDS, SESSIONS AND LOGIN LIMITS
# ============================================================
# PURPOSE: Hash passwords with bcrypt. Give each signed-in browser a random
#          token in an HttpOnly cookie. Only the token's SHA-256 hash is stored.
# FAILURE CASES: wrong password or unknown email -> same 401 message (no account
#                leak); too many failures -> 429. The failure counter lives in
#                memory, so on Vercel it resets between instances.

LOGIN_FAILURES = {}  # email -> list of failure timestamps


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def check_login_limit(email: str):
    now = time.time()
    recent = [t for t in LOGIN_FAILURES.get(email, []) if now - t < LOGIN_WINDOW_SECONDS]
    LOGIN_FAILURES[email] = recent
    if len(recent) >= LOGIN_MAX_FAILURES:
        raise AppError("RATE_LIMITED", "Too many attempts. Try again in 15 minutes.", 429)


def start_session(user: User, response: Response, db: Session):
    token = secrets.token_urlsafe(32)
    db.add(UserSession(
        token_hash=hash_token(token),
        user_id=user.id,
        expires_at=datetime.utcnow() + timedelta(days=SESSION_DAYS),
    ))
    db.commit()
    response.set_cookie(
        key=COOKIE_NAME, value=token, httponly=True, secure=COOKIE_SECURE,
        samesite="lax", max_age=SESSION_DAYS * 24 * 3600, path="/",
    )


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Dependency: the signed-in user, or a 401."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise AppError("AUTH_REQUIRED", "Please sign in.", 401)
    row = db.get(UserSession, hash_token(token))
    if not row or row.expires_at < datetime.utcnow():
        raise AppError("AUTH_REQUIRED", "Your session has ended. Please sign in again.", 401)
    return db.get(User, row.user_id)


# ============================================================
# GROQ PROVIDER
# ============================================================
# PURPOSE: The only place that talks to Groq. Every agent calls ask_json().
# PROCESS: ask Groq for a JSON object (JSON mode), then pull out the object.
# FAILURE CASES:
# - key missing -> AI_UNAVAILABLE (details only in the server log)
# - Groq or network error -> LLM_ERROR
# - reply still invalid after two attempts -> LLM_ERROR, with the exact reason in the log

def _groq_call(system_prompt: str, user_prompt: str) -> str:
    if not GROQ_API_KEY:
        log.error("GROQ_API_KEY is not set")
        raise AppError("AI_UNAVAILABLE", "The AI service is not available right now.")
    llm = ChatGroq(
        api_key=GROQ_API_KEY,
        model=GROQ_MODEL,
        temperature=0.4,
        timeout=60,
        max_retries=1,
        model_kwargs={"response_format": {"type": "json_object"}},  # Groq JSON mode
    )
    try:
        reply = llm.invoke([SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)])
        return reply.content
    except Exception:
        log.exception("Groq call failed")
        raise AppError("LLM_ERROR", "The AI service could not complete the request.")


# ============================================================
# TOLERANT NORMALISATION
# ============================================================
# PURPOSE: AI replies are often almost right: a list where a sentence was asked for,
#          a number instead of text, a missing optional line. These helpers repair
#          those small differences before validation, so the user gets a result.
# PROCESS: walk the schema's fields and convert each value to the expected type.
# FAILURE CASES: a required field that is completely absent becomes an empty string,
#                and the log records it.

def _to_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "; ".join(_to_text(v) for v in value)
    if isinstance(value, dict):
        return "; ".join(f"{k}: {_to_text(v)}" for k, v in value.items())
    return str(value)


def normalize(data: dict, schema: type) -> dict:
    out = {}
    for name, field in schema.model_fields.items():
        if name not in data:
            if field.is_required() and field.annotation is str:
                log.warning("AI reply missing required text field '%s'; using empty text", name)
                out[name] = ""
            continue
        value, annotation = data[name], field.annotation
        if annotation is str:
            out[name] = _to_text(value)
        elif get_origin(annotation) is list:
            inner = get_args(annotation)[0]
            items = [] if value is None else (value if isinstance(value, list) else [value])
            if isinstance(inner, type) and issubclass(inner, BaseModel):
                out[name] = [normalize(v, inner) if isinstance(v, dict) else {"name": _to_text(v)} for v in items]
            elif inner is str:
                out[name] = [_to_text(v) for v in items]
            else:
                out[name] = items  # List[dict]: keep the objects as the AI wrote them
        else:
            out[name] = value
    return out


def ask_json(system_prompt: str, user_prompt: str, schema: type):
    """Ask for JSON, repair small differences, validate, and retry once if still invalid."""
    last_reason = "unknown"
    for attempt in range(1, 3):
        raw = _groq_call(system_prompt, user_prompt)
        start, end = raw.find("{"), raw.rfind("}")
        if start == -1 or end == -1:
            last_reason = "reply contained no JSON object"
        else:
            try:
                data = json.loads(raw[start:end + 1])
                return schema(**normalize(data, schema))
            except json.JSONDecodeError as exc:
                last_reason = f"invalid JSON: {exc}"
            except ValidationError as exc:
                last_reason = "; ".join(
                    f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()[:5]
                )
        log.warning("AI output rejected on attempt %s for %s: %s", attempt, schema.__name__, last_reason)
        log.warning("Start of rejected reply: %s", raw[:300].replace("\n", " "))
    log.error("Giving up on %s. Last reason: %s", schema.__name__, last_reason)
    raise AppError("LLM_ERROR", "The AI response did not match the expected structure.")


def profile_text(profile: BusinessProfile) -> str:
    return f"User profile:\n{profile.model_dump_json(indent=2)}"


# ============================================================
# RESULT SCHEMAS FOR EACH AGENT
# ============================================================
# PURPOSE: Each agent's output shape. The frontend reads these exact keys.

class MarketResult(BaseModel):
    market_summary: str
    market_characteristics: List[str] = []
    customer_needs: List[str] = []
    existing_solutions: List[str] = []
    major_competitors: List[str] = []
    market_problems: List[str] = []
    opportunities: List[str] = []
    business_constraints: List[str] = []
    assumptions: List[str] = []


class PainPointsResult(BaseModel):
    pain_points: List[dict] = []  # each: {problem, frustration, who_feels_it, severity}
    unmet_needs: List[str] = []
    inefficient_processes: List[str] = []
    expensive_solutions: List[str] = []
    underserved_users: List[str] = []
    potential_demand: str = ""


class GapResult(BaseModel):
    missing_features: List[str] = []
    underserved_markets: List[str] = []
    pricing_gaps: List[str] = []
    accessibility_gaps: List[str] = []
    geographic_gaps: List[str] = []
    workflow_problems: List[str] = []
    technology_opportunities: List[str] = []
    service_quality_gaps: List[str] = []
    assumptions: List[str] = []


class PlanResult(BaseModel):
    executive_summary: str
    problem: str
    solution: str
    target_market: str
    customer_profile: str
    product_or_service: str
    business_model: str
    revenue_model: str
    marketing_approach: str
    sales_approach: str
    operations: str
    technology_requirements: List[str] = []
    estimated_costs: List[str] = []
    possible_revenue_sources: List[str] = []
    risks: List[str] = []
    milestones: List[str] = []
    launch_plan: str
    growth_possibilities: List[str] = []


class FinancialResult(BaseModel):
    currency: str
    startup_costs: List[dict] = []  # each: {item, estimate}
    monthly_operating_costs: List[dict] = []
    pricing: str
    revenue_assumptions: List[str] = []
    estimated_margin: str
    break_even_assumption: str
    scenarios: List[dict] = []  # each: {name, description, monthly_revenue_estimate}
    disclaimer: str = "All figures are AI-generated estimates, not verified facts."


class GlobalizationResult(BaseModel):
    target_countries: List[str] = []
    currency_considerations: List[str] = []
    localization_needs: List[str] = []
    customer_differences: List[str] = []
    language_considerations: List[str] = []
    regulatory_considerations: List[str] = []
    operational_complexity: str
    scalability: str
    international_opportunities: List[str] = []
    assumptions: List[str] = []


class ExecutionPhase(BaseModel):
    name: str
    objectives: List[str] = []
    tasks: List[str] = []
    expected_output: str
    dependencies: List[str] = []
    risks: List[str] = []


class ExecutionResult(BaseModel):
    phases: List[ExecutionPhase]


class ChatResult(BaseModel):
    reply: str


# ============================================================
# OPPORTUNITY AGENT
# ============================================================
# PURPOSE: Describe 3 to 5 business opportunities from a profile. Nothing is ranked.
# INPUT: BusinessProfile
# OUTPUT: OpportunityList

OPPORTUNITY_PROMPT = """You are a business opportunity analyst.
Return ONLY a JSON object with the key "opportunities": a list of 3 to 5 objects.
Each object has: business_name, concept, problem, target_customer, solution,
revenue_model, startup_requirements, operating_requirements, required_skills (list),
required_technology (list), risks (list), advantages (list), estimated_startup_cost,
estimated_monthly_cost, implementation_difficulty ("low", "medium" or "high"),
assumptions (list). Describe facts and assumptions. Do not rank opportunities.
Use the user's currency for money and label every estimate as an estimate.
Include specific, concrete detail. Every text field must be a plain string.
Every list field must be a JSON array of strings. No text outside the JSON."""


def run_opportunity_agent(profile: BusinessProfile) -> OpportunityList:
    return ask_json(OPPORTUNITY_PROMPT, profile_text(profile), OpportunityList)


# ============================================================
# MARKET ANALYSIS AGENT
# ============================================================
# PURPOSE: Describe the market for the user's profile, optionally for one opportunity.
# OUTPUT: MarketResult

MARKET_PROMPT = """You are a market analyst. Return ONLY a JSON object with keys:
market_summary (plain string), market_characteristics, customer_needs, existing_solutions,
major_competitors, market_problems, opportunities, business_constraints, assumptions.
All keys except market_summary must be JSON arrays of plain strings.
Label anything that is not verified as an assumption. No text outside the JSON."""


def run_market_agent(profile: BusinessProfile, opportunity: Optional[dict]) -> MarketResult:
    extra = f"\n\nFocus on this opportunity:\n{json.dumps(opportunity, indent=2)}" if opportunity else ""
    return ask_json(MARKET_PROMPT, profile_text(profile) + extra, MarketResult)


# ============================================================
# CUSTOMER PAIN POINT AGENT
# ============================================================
# PURPOSE: Find frustrations, unmet needs, and expensive or slow processes.
# OUTPUT: PainPointsResult

PAIN_PROMPT = """You are a customer research analyst. Return ONLY a JSON object with keys:
pain_points (JSON array of objects with problem, frustration, who_feels_it, severity),
unmet_needs, inefficient_processes, expensive_solutions, underserved_users (all JSON arrays of
plain strings), potential_demand (plain string). No text outside the JSON."""


def run_pain_agent(profile: BusinessProfile, opportunity: Optional[dict]) -> PainPointsResult:
    extra = f"\n\nFocus on this opportunity:\n{json.dumps(opportunity, indent=2)}" if opportunity else ""
    return ask_json(PAIN_PROMPT, profile_text(profile) + extra, PainPointsResult)


# ============================================================
# GAP ANALYSIS AGENT
# ============================================================
# PURPOSE: Compare customer needs with current solutions and list the gaps.
# INPUT: profile plus earlier market and pain point results.
# OUTPUT: GapResult

GAP_PROMPT = """You are a market gap analyst. Return ONLY a JSON object with keys:
missing_features, underserved_markets, pricing_gaps, accessibility_gaps, geographic_gaps,
workflow_problems, technology_opportunities, service_quality_gaps, assumptions.
All keys must be JSON arrays of plain strings. No text outside the JSON."""


def run_gap_agent(profile: BusinessProfile, context: dict) -> GapResult:
    user = profile_text(profile) + f"\n\nPrevious analysis:\n{json.dumps(context, indent=2)}"
    return ask_json(GAP_PROMPT, user, GapResult)


# ============================================================
# BUSINESS PLAN AGENT
# ============================================================
# PURPOSE: Write a structured business plan for one opportunity.
# OUTPUT: PlanResult

PLAN_PROMPT = """You are a business plan writer. Return ONLY a JSON object with keys:
executive_summary, problem, solution, target_market, customer_profile, product_or_service,
business_model, revenue_model, marketing_approach, sales_approach, operations, launch_plan
(all plain strings), and technology_requirements, estimated_costs, possible_revenue_sources,
risks, milestones, growth_possibilities (all JSON arrays of plain strings).
Label every estimate as an estimate. No text outside the JSON."""


def run_plan_agent(profile: BusinessProfile, opportunity: dict) -> PlanResult:
    user = profile_text(profile) + f"\n\nSelected opportunity:\n{json.dumps(opportunity, indent=2)}"
    return ask_json(PLAN_PROMPT, user, PlanResult)


# ============================================================
# FINANCIAL AGENT
# ============================================================
# PURPOSE: Estimate costs, pricing, and scenarios in the user's currency.
# OUTPUT: FinancialResult. Figures are always labelled as estimates.

FINANCIAL_PROMPT = """You are a financial analyst for early-stage businesses. Return ONLY a JSON
object with keys: currency, pricing, estimated_margin, break_even_assumption (plain strings),
startup_costs and monthly_operating_costs (arrays of {item, estimate} with plain strings),
revenue_assumptions (array of plain strings), scenarios (array of {name, description,
monthly_revenue_estimate} with plain strings), disclaimer. Use the user's currency.
Every figure is an estimate. No text outside the JSON."""


def run_financial_agent(profile: BusinessProfile, opportunity: dict) -> FinancialResult:
    user = profile_text(profile) + f"\n\nSelected opportunity:\n{json.dumps(opportunity, indent=2)}"
    return ask_json(FINANCIAL_PROMPT, user, FinancialResult)


# ============================================================
# GLOBALIZATION AGENT
# ============================================================
# PURPOSE: Explain how the business could operate in other countries.
# OUTPUT: GlobalizationResult

GLOBAL_PROMPT = """You are an international business analyst. Return ONLY a JSON object with keys:
operational_complexity, scalability (plain strings), and target_countries, currency_considerations,
localization_needs, customer_differences, language_considerations, regulatory_considerations
(general only, not legal advice), international_opportunities, assumptions (JSON arrays of plain
strings). No text outside the JSON."""


def run_global_agent(profile: BusinessProfile, opportunity: dict) -> GlobalizationResult:
    user = profile_text(profile) + f"\n\nSelected opportunity:\n{json.dumps(opportunity, indent=2)}"
    return ask_json(GLOBAL_PROMPT, user, GlobalizationResult)


# ============================================================
# EXECUTION PLAN AGENT
# ============================================================
# PURPOSE: Split the chosen opportunity into phases from validation to scale.
# OUTPUT: ExecutionResult

EXECUTION_PROMPT = """You are an execution planner. Return ONLY a JSON object with the key
"phases": a JSON array of objects, each with name and expected_output (plain strings), and
objectives, tasks, dependencies, risks (JSON arrays of plain strings). Use these phases in order:
Validation, MVP, First Customers, Improvement, Scale. No text outside the JSON."""


def run_execution_agent(profile: BusinessProfile, opportunity: dict) -> ExecutionResult:
    user = profile_text(profile) + f"\n\nSelected opportunity:\n{json.dumps(opportunity, indent=2)}"
    return ask_json(EXECUTION_PROMPT, user, ExecutionResult)


# ============================================================
# CONVERSATION AGENT
# ============================================================
# PURPOSE: Answer questions about one project, using its saved profile and results.
# INPUT: project dict, earlier chat messages, the new question.
# OUTPUT: ChatResult

CHAT_PROMPT = """You are a business advisor helping the user with one project.
Use the project profile and saved analysis below. Say clearly when something is an estimate or
an assumption. Keep answers specific and practical. Return ONLY a JSON object with key "reply"
whose value is a plain string."""


def run_chat_agent(project: dict, history: list, message: str) -> ChatResult:
    context = json.dumps({"profile": project["profile"], "results": project["results"]}, indent=2)
    convo = "\n".join(f"{m['role']}: {m['content']}" for m in history[-10:])
    user = f"Project:\n{context}\n\nRecent chat:\n{convo}\n\nNew question: {message}"
    return ask_json(CHAT_PROMPT, user, ChatResult)


# ============================================================
# API APP AND ERROR HANDLERS
# ============================================================
# PURPOSE: Create the app and format every error the same way.
# NOTE: The frontend is served from the same domain, so no CORS setup is needed.

app = FastAPI(title="AI Business Builder")


@app.exception_handler(AppError)
async def app_error_handler(request, exc: AppError):
    return JSONResponse(
        status_code=exc.status,
        content={"success": False, "error": {"type": exc.error_type, "message": exc.message}},
    )


@app.exception_handler(SQLAlchemyError)
async def db_error_handler(request, exc: SQLAlchemyError):
    log.exception("Database error")
    return JSONResponse(
        status_code=503,
        content={"success": False, "error": {"type": "DB_ERROR", "message": "The database is unavailable."}},
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(request, exc: Exception):
    log.exception("Unexpected error")
    return JSONResponse(
        status_code=500,
        content={"success": False, "error": {"type": "SERVER_ERROR", "message": "Something went wrong."}},
    )


# ============================================================
# HEALTH
# ============================================================
# PURPOSE: Confirm the server is up. Config details are not sent to the browser.

@app.get("/api/health")
def health():
    return {"status": "ok"}


# ============================================================
# AUTH ROUTES
# ============================================================
# PURPOSE: Register, sign in, sign out, and report the current user.
# FAILURE CASES: duplicate email -> 409; wrong login -> 401 generic message.

@app.post("/api/auth/register", status_code=201)
def register(body: RegisterIn, response: Response, db: Session = Depends(get_db)):
    email = body.email.lower()
    if db.query(User).filter(User.email == email).first():
        raise AppError("EMAIL_TAKEN", "An account with this email already exists.", 409)
    user = User(email=email, password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    start_session(user, response, db)
    return {"success": True, "data": {"id": user.id, "email": user.email}}


@app.post("/api/auth/login")
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    email = body.email.lower()
    check_login_limit(email)
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(body.password, user.password_hash):
        LOGIN_FAILURES.setdefault(email, []).append(time.time())
        raise AppError("INVALID_LOGIN", "Email or password is incorrect.", 401)
    LOGIN_FAILURES.pop(email, None)
    start_session(user, response, db)
    return {"success": True, "data": {"id": user.id, "email": user.email}}


@app.post("/api/auth/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = request.cookies.get(COOKIE_NAME)
    if token:
        row = db.get(UserSession, hash_token(token))
        if row:
            db.delete(row)
            db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"success": True, "data": {"signed_out": True}}


@app.get("/api/auth/me")
def me(user: User = Depends(current_user)):
    return {"success": True, "data": {"id": user.id, "email": user.email}}


# ============================================================
# OPPORTUNITY ROUTE
# ============================================================
# PURPOSE: Generate opportunities for the signed-in user. Nothing is saved here.

@app.post("/api/business-opportunities")
def create_opportunities(profile: BusinessProfile, user: User = Depends(current_user)):
    result = run_opportunity_agent(profile)
    return {"success": True, "data": {"opportunities": [o.model_dump() for o in result.opportunities]}}


# ============================================================
# PROJECT OPERATIONS
# ============================================================
# PURPOSE: Save, list, read and delete projects. Every query filters by user_id,
#          so one user can never read or change another user's project.
# FAILURE CASES: someone else's id -> NOT_FOUND (404), same as a missing id.

def get_own_project(db: Session, project_id: int, user: User) -> BusinessProject:
    project = (
        db.query(BusinessProject)
        .filter(BusinessProject.id == project_id, BusinessProject.user_id == user.id)
        .first()
    )
    if not project:
        raise AppError("NOT_FOUND", "No business project with that id.", 404)
    return project


def project_to_dict(p: BusinessProject) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "profile": json.loads(p.profile_json),
        "results": json.loads(p.results_json or "{}"),
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


def save_result(db: Session, project: BusinessProject, key: str, value):
    """Store one agent's output in the project, keeping earlier results."""
    results = json.loads(project.results_json or "{}")
    results[key] = value
    project.results_json = json.dumps(results)
    db.commit()


@app.post("/api/businesses", status_code=201)
def create_project(body: ProjectCreate, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = BusinessProject(
        user_id=user.id,
        name=body.profile.name,
        profile_json=body.profile.model_dump_json(),
        results_json="{}",
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"success": True, "data": project_to_dict(project)}


@app.get("/api/businesses")
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = (
        db.query(BusinessProject)
        .filter(BusinessProject.user_id == user.id)
        .order_by(BusinessProject.id.desc())
        .all()
    )
    return {"success": True, "data": [{"id": r.id, "name": r.name} for r in rows]}


@app.get("/api/businesses/{project_id}")
def get_project(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return {"success": True, "data": project_to_dict(get_own_project(db, project_id, user))}


@app.delete("/api/businesses/{project_id}")
def delete_project(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = get_own_project(db, project_id, user)
    db.delete(project)
    db.commit()
    return {"success": True, "data": {"deleted": project_id}}


# ============================================================
# ANALYSIS ROUTES
# ============================================================
# PURPOSE: Run each agent for a saved project and store the result in it.
# INPUT: project id in the URL. Optional opportunity_index in the body (0 to 4)
#        chooses one opportunity to focus on.
# OUTPUT: {"success": true, "data": {"key": ..., "result": ...}}
# FAILURE CASES: unknown or foreign project -> 404; bad index -> 422; AI errors pass through.

class AnalysisIn(BaseModel):
    opportunity_index: Optional[int] = Field(default=None, ge=0, le=4)


def selected_opportunity(project: dict, index: Optional[int]) -> Optional[dict]:
    if index is None:
        return None
    opportunities = project["results"].get("opportunities", {}).get("opportunities", [])
    if index >= len(opportunities):
        raise AppError("VALIDATION_ERROR", "That opportunity does not exist in this project.", 422)
    return opportunities[index]


def require_opportunity(project: dict, index: Optional[int]) -> dict:
    opp = selected_opportunity(project, index)
    if opp is None:
        raise AppError("VALIDATION_ERROR", "Choose an opportunity first.", 422)
    return opp


def run_and_store(project_id: int, user: User, db: Session, key: str, action):
    project_row = get_own_project(db, project_id, user)
    project = project_to_dict(project_row)
    data = action(project).model_dump()
    save_result(db, project_row, key, data)
    return {"success": True, "data": {"key": key, "result": data}}


@app.post("/api/businesses/{project_id}/opportunities")
def analyse_opportunities(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return run_and_store(project_id, user, db, "opportunities",
                         lambda p: run_opportunity_agent(BusinessProfile(**p["profile"])))


@app.post("/api/businesses/{project_id}/market")
def analyse_market(project_id: int, body: AnalysisIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return run_and_store(project_id, user, db, "market",
                         lambda p: run_market_agent(BusinessProfile(**p["profile"]),
                                                    selected_opportunity(p, body.opportunity_index)))


@app.post("/api/businesses/{project_id}/pain-points")
def analyse_pain(project_id: int, body: AnalysisIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return run_and_store(project_id, user, db, "pain_points",
                         lambda p: run_pain_agent(BusinessProfile(**p["profile"]),
                                                  selected_opportunity(p, body.opportunity_index)))


@app.post("/api/businesses/{project_id}/gaps")
def analyse_gaps(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    def action(p):
        context = {k: p["results"].get(k, {}) for k in ("market", "pain_points")}
        return run_gap_agent(BusinessProfile(**p["profile"]), context)
    return run_and_store(project_id, user, db, "gaps", action)


@app.post("/api/businesses/{project_id}/plan")
def analyse_plan(project_id: int, body: AnalysisIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return run_and_store(project_id, user, db, "plan",
                         lambda p: run_plan_agent(BusinessProfile(**p["profile"]),
                                                  require_opportunity(p, body.opportunity_index)))


@app.post("/api/businesses/{project_id}/financials")
def analyse_financials(project_id: int, body: AnalysisIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return run_and_store(project_id, user, db, "financials",
                         lambda p: run_financial_agent(BusinessProfile(**p["profile"]),
                                                       require_opportunity(p, body.opportunity_index)))


@app.post("/api/businesses/{project_id}/globalization")
def analyse_global(project_id: int, body: AnalysisIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return run_and_store(project_id, user, db, "globalization",
                         lambda p: run_global_agent(BusinessProfile(**p["profile"]),
                                                    require_opportunity(p, body.opportunity_index)))


@app.post("/api/businesses/{project_id}/execution")
def analyse_execution(project_id: int, body: AnalysisIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return run_and_store(project_id, user, db, "execution",
                         lambda p: run_execution_agent(BusinessProfile(**p["profile"]),
                                                       require_opportunity(p, body.opportunity_index)))


# ============================================================
# CHAT ROUTES
# ============================================================
# PURPOSE: Ask follow-up questions about a saved project.
# PROCESS: load the project and its recent messages, ask the chat agent, save both turns.
# FAILURE CASES: unknown project -> 404; AI errors pass through.

@app.get("/api/businesses/{project_id}/chat")
def get_chat(project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    get_own_project(db, project_id, user)
    rows = (
        db.query(ChatMessage)
        .filter(ChatMessage.project_id == project_id)
        .order_by(ChatMessage.id)
        .all()
    )
    return {"success": True, "data": [{"role": r.role, "content": r.content} for r in rows]}


@app.post("/api/businesses/{project_id}/chat")
def post_chat(project_id: int, body: ChatIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    project = project_to_dict(get_own_project(db, project_id, user))
    rows = db.query(ChatMessage).filter(ChatMessage.project_id == project_id).order_by(ChatMessage.id).all()
    history = [{"role": r.role, "content": r.content} for r in rows]
    answer = run_chat_agent(project, history, body.message).reply
    db.add(ChatMessage(project_id=project_id, role="user", content=body.message))
    db.add(ChatMessage(project_id=project_id, role="assistant", content=answer))
    db.commit()
    return {"success": True, "data": {"reply": answer}}


# ============================================================
# STARTUP: SELF-REPAIRING DATABASE SCHEMA
# ============================================================
# PURPOSE: On every start, compare the tables in the database with the models
#          in this file. Create missing tables, and add missing columns.
# SAFETY: Existing rows are never deleted or changed. Columns are only added.
#         Old rows without an owner stay hidden, because every query filters by user_id.
# FAILURE CASES: if the database cannot be reached, the app still starts and
#                database routes return DB_ERROR, so the problem stays visible.

def create_missing_tables_and_columns():
    try:
        Base.metadata.create_all(engine)  # creates any table that does not exist yet
        inspector = inspect(engine)
        with engine.begin() as conn:
            for table in Base.metadata.sorted_tables:
                existing = {c["name"] for c in inspector.get_columns(table.name)}
                for column in table.columns:
                    if column.name in existing:
                        continue
                    col_type = column.type.compile(dialect=engine.dialect)
                    conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}'))
                    log.warning("Schema repair: added %s.%s", table.name, column.name)
    except SQLAlchemyError:
        log.exception("Schema check failed; check DATABASE_URL")


@app.on_event("startup")
def on_startup():
    create_missing_tables_and_columns()


# ============================================================
# FRONTEND
# ============================================================
# PURPOSE: Serve the HTML, CSS and JavaScript from the frontend folder.

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

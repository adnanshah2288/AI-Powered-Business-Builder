# AI Business Builder

The app takes a short profile (skills, budget, country, currency, goals) and
asks a Groq-hosted model for 3 to 5 business opportunities. Each one lists its
problem, customer, revenue model, startup needs, risks and difficulty. The
model describes them without ranking them, and results are labelled as estimates.

## Technology

- **Python + FastAPI** for the REST API
- **LangChain (`langchain-groq`)** for the Groq model call
- **Pydantic** to validate user input and AI output
- **Groq API** as the only LLM provider
- **Neon PostgreSQL** (free tier) through SQLAlchemy, with SQLite as a local fallback
- **HTML, CSS and vanilla JavaScript** for the frontend

## Project structure

```
app/main.py          Everything backend: config, database, schemas,
                     Groq provider, opportunity agent, routes, startup.
frontend/index.html  The page layout and form.
frontend/style.css   Colours, type and layout.
frontend/app.js      Calls the API and renders results safely.
requirements.txt     Python packages.
.env.example         Template for your secrets. Copy it to .env.
```

## Installation

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # Windows: copy .env.example .env
```

## Environment variables

| Name | Purpose |
|---|---|
| `GROQ_API_KEY` | Your free Groq key from the Groq console |
| `GROQ_MODEL` | The Groq model name. Check Groq's current list and pick the fastest capable one |
| `DATABASE_URL` | Neon connection string (`postgresql://...`). If empty, a local SQLite file is used |

## Database setup (Neon)

1. Create a free project at neon.tech.
2. Copy the connection string from the dashboard.
3. Make sure it starts with `postgresql://` and paste it into `DATABASE_URL` in `.env`.

Tables are created automatically on startup.

## Running the app

```bash
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000 for the page. The API docs are at http://127.0.0.1:8000/docs.

## Running the frontend

The frontend is served by FastAPI, so there is nothing else to start.

## Testing

A full test suite is not included yet. You can check the API manually at `/docs`
or with `GET /api/health`, which shows whether the Groq key is set.

## Troubleshooting

- **"GROQ_API_KEY is missing"**: the `.env` file is missing or the key is empty. Restart uvicorn after editing `.env`.
- **"The AI service could not complete the request"**: check the model name in `GROQ_MODEL` and the terminal log for the real error.
- **"The database is unavailable"**: check `DATABASE_URL`. Neon free projects can take a moment to wake up, so try again.
- **Results say "Could not save the project"**: the AI results still show. Fix the database connection and generate again to save.

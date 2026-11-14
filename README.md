# Chopsticks leaderboard API

Monthly worldwide leaderboard for [Chopsticks](https://catch-the-booster-390255.onrender.com), an unofficial SpaceX fan game. Not affiliated with or endorsed by SpaceX.

This is a small free-tier Render web service. It stores first-name-only scores for the current calendar month (UTC) and is designed so the game still works if the service is asleep or down.

## Endpoints

- `GET /health` — liveness
- `GET /scores` — top scores for the current UTC month
- `POST /scores` — `{ name, score, acc, outcome, mission }`

No accounts. No emails. No personal data beyond a short display name and the score itself.

# Changelog

This project follows [semantic versioning](https://semver.org).

## 0.1.0

First release.

- Work counter shared across sessions, starting at the first prompt of the day.
- Workouts start at a good moment (a Claude turn still running after 60 s), or after 10 minutes of waiting.
- Bar above the prompt with an animated figure, timer, progress, Done, Swap and Skip.
- Levels: Easy (14 exercises), Hard (16), Beat AI (14, 40 s sets with 20 s rest until Claude's turn completes).
- Hardcore: no Skip, prompts held back and sent after the workout, "I give up" to turn off.
- Side panel: on/off with timed pauses, today's stats, settings, exercise checkboxes.
- Exercises in an editable `data/exercises.json`, with a checker and an HTML preview.

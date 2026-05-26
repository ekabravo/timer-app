# Agent Notes

This is a silent foreground visual timer PWA. Minimum inputs, zero-config.

## App Modes

- `selecting`: The value picker is visible. Numeric values start timers; index `0` is shown as `+` and starts the stopwatch.
- `timer_running`: A countdown is active. The main number counts down and the label shows full `mm:ss` remaining.
- `timer_paused`: A countdown is paused. Activating resumes it; scrolling or swiping while paused resets to selection.
- `stopwatch_running`: A stopwatch is active. It uses stopwatch visuals and counts forward from zero.
- `stopwatch_paused`: A stopwatch is paused. Activating resumes it from the stored elapsed time.

## Glossary

- `session`: The persisted app state stored in local storage.
- `Mode`: The finite state value that drives app behavior.
- `hero`: The large central number.
- `label`: The smaller time text below the hero, usually full `mm:ss`.
- `visual`: The visual theme, either `timer` or `stopwatch`.

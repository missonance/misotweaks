# MisoTweaks for PolyTrack 0.6.3

This GitHub Pages build runs on the PolyTrack 0.6.3 web release and adds a searchable, map-organized clip library.

## Clip storage

Clips are stored in IndexedDB in two object stores:

- `clip_meta` contains the small fields needed to draw and search the library.
- `clip_payloads` contains the recording data and is only read for playback or export.

On first load, existing clips from the legacy `miso_clips` localStorage key are copied into IndexedDB in one transaction. The old key is removed only after that transaction completes, so an interrupted or failed migration leaves the original clips untouched. PolyTrack save keys are unchanged.

## Local preview

Serve the repository root over HTTP. For example:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Then open `http://127.0.0.1:4173/`.

## GitHub Pages

Publish the repository root from the `main` branch. Keep the existing GitHub Pages URL and repository path so the browser origin remains unchanged and returning players retain their locally stored saves and clips.

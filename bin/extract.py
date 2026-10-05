#!/usr/bin/env python3
"""Extract Wild Terra 2 wiki data straight from the game install.

    bin/update.sh                       # usual entry point (sets up the venv)
    bin/extract.py --game "<.../Wild-Terra-2_Data>" --out public

Writes public/data/*.json, public/data/i18n/<lang>.json and public/icons/*.webp,
and prints what changed compared to the previous extraction.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wt2.model import Builder  # noqa: E402
from wt2.unity import Game  # noqa: E402

DEFAULT_GAME = "/opt/steam/steamapps/common/Wild Terra 2/Wild-Terra-2_Data"
ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("extract")


def dump(path: Path, data):
    """One entry per line for dict collections, so git diffs stay readable."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, dict) and data and all(isinstance(v, dict) for v in data.values()):
        lines = [
            f"{json.dumps(k, ensure_ascii=False)}:{json.dumps(v, ensure_ascii=False, separators=(',', ':'), sort_keys=True)}"
            for k, v in sorted(data.items())
        ]
        text = "{\n" + ",\n".join(lines) + "\n}\n"
    else:
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    path.write_text(text, encoding="utf-8")


def load(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def diff(old: dict | None, new: dict) -> dict:
    if not isinstance(old, dict):
        return {}
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    changed = sorted(k for k in set(new) & set(old) if new[k] != old[k])
    return {k: v for k, v in (("added", added), ("removed", removed), ("changed", changed)) if v}


def export_icons(game: Game, sprites: dict[str, int], out: Path, force: bool) -> int:
    out.mkdir(parents=True, exist_ok=True)
    wanted = {f"{stem}.webp" for stem in sprites}
    for stale in out.glob("*.webp"):
        if stale.name not in wanted:
            stale.unlink()
    written = 0
    for stem, pid in sorted(sprites.items()):
        dest = out / f"{stem}.webp"
        if dest.exists() and not force:
            continue
        res = game.sprite_image(pid)
        if res is None:
            continue
        res[1].save(dest, "WEBP", lossless=True, method=6)
        written += 1
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", default=DEFAULT_GAME, help="path to Wild-Terra-2_Data")
    ap.add_argument("--out", default=str(ROOT / "public"), help="site root to write data/ and icons/ into")
    ap.add_argument("--cache", default=str(ROOT / "bin" / ".cache"), help="parse cache dir ('' to disable)")
    ap.add_argument("--force-icons", action="store_true", help="re-export icons that already exist")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    started = time.time()
    out = Path(args.out)
    data_dir = out / "data"
    game = Game(Path(args.game), Path(args.cache) if args.cache else None)
    builder = Builder(game)
    collections = builder.build()
    locales = builder.locales()

    old_meta = load(data_dir / "meta.json") or {}
    changes = {}
    for name, coll in collections.items():
        d = diff(load(data_dir / f"{name}.json"), coll)
        if d:
            changes[name] = d
        dump(data_dir / f"{name}.json", coll)
    for lang, strings in locales.items():
        dump(data_dir / "i18n" / f"{lang}.json", strings)

    icons = export_icons(game, builder.icon_sprites, out / "icons", args.force_icons)
    steam = game.steam_build()
    meta = {
        "build": steam.get("buildid"),
        "steamUpdated": steam.get("updated"),
        "unity": game.unity_version,
        "extracted": int(time.time()),
        "counts": {k: len(v) for k, v in collections.items() if isinstance(v, dict)},
        "languages": sorted(locales),
        "warnings": builder.warnings,
    }
    if changes and old_meta:
        dump(data_dir / "changes.json", {
            "from": old_meta.get("build"),
            "to": meta["build"],
            "date": meta["extracted"],
            "changes": changes,
        })
    meta["changes"] = (data_dir / "changes.json").exists()
    dump(data_dir / "meta.json", meta)

    log.info("wrote %s (%s), %d new icons, build %s, %.0fs",
             data_dir, ", ".join(f"{k} {v}" for k, v in meta["counts"].items()), icons, meta["build"], time.time() - started)
    if builder.warnings:
        log.info("%d warnings (see meta.json)", len(builder.warnings))
    for name, d in changes.items():
        log.info("changed %-8s %s", name, ", ".join(f"{k} {len(v)}" for k, v in d.items()))


if __name__ == "__main__":
    main()

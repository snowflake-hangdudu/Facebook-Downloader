"""Build a deterministic download-extension archive from runtime files."""
from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_DIRS = {
    "_locales", "assets", "content", "docs", "icons", "lib", "popup", "shared", "social", "rules"
}
RUNTIME_ROOT_FILES = {"background.js"}
EXCLUDE_PARTS = {"test", "tests", "store", "scripts", "node_modules", ".git", "_metadata", "previews", "acceptance"}
EXCLUDE_NAMES = {".gitignore", ".DS_Store", "Thumbs.db"}
FORBIDDEN_SUFFIXES = {".zip", ".xpi", ".pem", ".key", ".p12", ".map"}
DEBUG_FLAG = re.compile(r"(DownloaderKit\.DEBUG\s*=\s*)(?:true|false)(\s*;\s*//\s*@pack:debug)")


def references_in_manifest(manifest: dict) -> list[str]:
    references: list[str] = []
    background = manifest.get("background", {})
    references.extend(filter(None, [background.get("service_worker"), *background.get("scripts", [])]))
    action = manifest.get("action", {})
    for reference in (
        action.get("default_popup"), manifest.get("options_page"),
        manifest.get("options_ui", {}).get("page"), manifest.get("devtools_page"),
    ):
        if reference:
            references.append(reference)
    references.extend(manifest.get("icons", {}).values())
    references.extend(action.get("default_icon", {}).values())
    for key in ("side_panel", "chrome_url_overrides"):
        references.extend(value for value in manifest.get(key, {}).values() if isinstance(value, str))
    references.extend(manifest.get("sandbox", {}).get("pages", []))
    for entry in manifest.get("web_accessible_resources", []):
        references.extend(entry.get("resources", []))
    for entry in manifest.get("declarative_net_request", {}).get("rule_resources", []):
        if entry.get("path"):
            references.append(entry["path"])
    for entry in manifest.get("content_scripts", []):
        references.extend(entry.get("js", []))
        references.extend(entry.get("css", []))
    return references


def validate_manifest(manifest: dict) -> None:
    if manifest.get("manifest_version") != 3:
        raise SystemExit("PACK FAIL manifest_version 必须为 3")
    missing = []
    for reference in references_in_manifest(manifest):
        path = Path(reference)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"PACK FAIL manifest 引用越界: {reference}")
        if not (any(ROOT.glob(reference)) if "*" in reference else (ROOT / path).is_file()):
            missing.append(reference)
    if missing:
        raise SystemExit("PACK FAIL manifest 文件不存在:\n" + "\n".join(sorted(set(missing))))


def should_include(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return (
        path.is_file()
        and (relative.parts[0] in RUNTIME_DIRS or (len(relative.parts) == 1 and relative.name in RUNTIME_ROOT_FILES))
        and not any(part in EXCLUDE_PARTS for part in relative.parts)
        and path.name not in EXCLUDE_NAMES
        and not (relative.parts[0] == "docs" and path.suffix.lower() == ".md")
        and path.suffix.lower() not in FORBIDDEN_SUFFIXES
        and not path.name.startswith(".env")
    )


def package_release(manifest_name: str, output_name: str) -> None:
    manifest_path = ROOT / manifest_name
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"PACK FAIL {manifest_name}: {error}") from error
    validate_manifest(manifest)

    files = sorted(
        (path for path in ROOT.rglob("*") if should_include(path)),
        key=lambda path: path.relative_to(ROOT).as_posix(),
    )
    debug_path = ROOT / "shared" / "debug-flag.js"
    if not debug_path.is_file():
        raise SystemExit("PACK FAIL missing shared/debug-flag.js")
    debug_source, debug_count = DEBUG_FLAG.subn(
        r"\1false\2", debug_path.read_text(encoding="utf-8"), count=1
    )
    if debug_count != 1:
        raise SystemExit("PACK FAIL expected exactly one @pack:debug marker")

    output = ROOT / output_name
    staging = output.with_suffix(output.suffix + ".tmp")
    try:
        with zipfile.ZipFile(staging, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            for path in files:
                relative = path.relative_to(ROOT).as_posix()
                if path == debug_path:
                    archive.writestr(relative, debug_source)
                else:
                    archive.write(path, relative)
        staging.replace(output)
    finally:
        staging.unlink(missing_ok=True)
    print(f"OK {output} files={len(files) + 1}")

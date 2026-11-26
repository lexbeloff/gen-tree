# -*- coding: utf-8 -*-
"""Проверка приватности перед коммитом / публикацией.

Использование:
  python -I tools/privacy_check.py --staged          # файлы в индексе git (содержимое из индекса)
  python -I tools/privacy_check.py --paths data site # файлы на диске

Код выхода: 0 — PASS, 1 — FAIL. Значения найденных данных не печатаются, только файл:строка и тип.
Список живых людей берётся из case/person-register.csv (локально; в CI его нет — тогда только WARN).
"""
import argparse, csv, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTER = os.path.join(ROOT, "case", "person-register.csv")

FORBIDDEN_PREFIXES = ("documents/", "case/", ".history/", ".claude/settings.local.json")
FORBIDDEN_FILES = ("index.md", "new.txt", "docs/roadmap.md")
FORBIDDEN_EXT = (".ged",)
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".tif", ".tiff", ".bmp")
IMAGE_ALLOWED = ("data/photos/", "site/", ".agents/skills/")  # .agents — вендорные навыки
PEOPLE_PHOTO_RX = re.compile(r"^data/people/[^/]+/photos/[^/]+$")  # публичные фото персон
PEOPLE_PRIVATE_RX = re.compile(r"^data/people/[^/]+/private/")      # приватная часть папки персоны
SKIP_CONTENT = ("tools/privacy_check.py",)

# серия свидетельства «I-ЧН №097974», военный билет «НМ №1234567», паспорт «73 05 123456»
DOC_PATTERNS = [
    ("номер свидетельства", re.compile(r"\b[IVXLC]{1,4}-[А-ЯЁ]{2}\s*№?\s*\d{6}\b")),
    ("номер документа (серия+№)", re.compile(r"\b[А-ЯЁ]{2}\s*№\s*\d{6,7}\b")),
]
WARN_PATTERNS = [
    ("похоже на серию/номер паспорта", re.compile(r"\b\d{2}\s\d{2}\s\d{6}\b")),
]


def living_dates():
    """{person_id: [строки дат в разных форматах]} для живых."""
    if not os.path.exists(REGISTER):
        return None
    out = {}
    with open(REGISTER, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if (row.get("living_status") or "").strip() != "living":
                continue
            m = re.search(r"(\d{4})-(\d{2})-(\d{2})", row.get("birth_estimate") or "")
            if not m:
                continue
            y, mo, d = m.groups()
            out[row["person_id"]] = [
                f"{y}-{mo}-{d}", f"{d}.{mo}.{y}", f"{int(d)}.{mo}.{y}", f"{d}/{mo}/{y}",
            ]
    return out


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True).stdout


def staged_files():
    raw = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    return [p for p in raw.decode("utf-8").split("\0") if p]


def disk_files(paths):
    files = []
    for p in paths:
        full = os.path.join(ROOT, p)
        if os.path.isfile(full):
            files.append(p.replace("\\", "/"))
        for dp, dn, fn in os.walk(full):
            # private/ в папках персон — в .gitignore; на диске не проверяем (в --staged ловится как FAIL)
            dn[:] = [d for d in dn if d not in ("node_modules", ".git", ".generated", "dist", "private")]
            for name in fn:
                files.append(os.path.relpath(os.path.join(dp, name), ROOT).replace("\\", "/"))
    return files


def read(path, staged):
    if staged:
        return git("show", f":{path}")
    try:
        with open(os.path.join(ROOT, path), "rb") as f:
            return f.read()
    except OSError:
        return b""


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--staged", action="store_true")
    g.add_argument("--paths", nargs="+")
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    files = staged_files() if a.staged else disk_files(a.paths)
    fails, warns = [], []
    living = living_dates()
    if living is None:
        warns.append("case/person-register.csv не найден — проверка дат живых пропущена")

    for path in files:
        low = path.lower()
        if low.startswith(FORBIDDEN_PREFIXES) or low in FORBIDDEN_FILES or low.endswith(FORBIDDEN_EXT):
            fails.append(f"{path}: приватный путь, не должен попадать в git")
            continue
        if PEOPLE_PRIVATE_RX.match(path):
            fails.append(f"{path}: приватная часть папки персоны, не должна попадать в git")
            continue
        if low.endswith(IMAGE_EXT):
            if not (low.startswith(IMAGE_ALLOWED) or PEOPLE_PHOTO_RX.match(path)):
                fails.append(f"{path}: изображение вне data/photos/ или site/")
            continue
        if path in SKIP_CONTENT:
            continue
        data = read(path, a.staged)
        if b"\0" in data[:4096]:
            continue
        text = data.decode("utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            for pid, variants in (living or {}).items():
                if any(v in line for v in variants):
                    fails.append(f"{path}:{n}: дата рождения живого человека ({pid})")
            for label, rx in DOC_PATTERNS:
                if rx.search(line):
                    fails.append(f"{path}:{n}: {label}")
            for label, rx in WARN_PATTERNS:
                if rx.search(line):
                    warns.append(f"{path}:{n}: {label}")

    print(f"privacy-check: проверено файлов: {len(files)}")
    for w in warns:
        print(f"  WARN  {w}")
    for f in fails:
        print(f"  FAIL  {f}")
    print("Вердикт: " + ("FAIL" if fails else "PASS"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

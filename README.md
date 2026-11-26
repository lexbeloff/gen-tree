# genTree

Семейное древо: исследование и публичная страница (GitHub Pages).

- Страница: https://lexbeloff.github.io/gen-tree/
- Данные древа — `data/people/<ФИО>/person.json` (одна папка на человека), источники — `data/sources.json`; формат — [docs/data-format.md](docs/data-format.md).
- Страница — `site/` (rspack + TypeScript + SCSS), собирается и публикуется GitHub Actions ([.github/workflows/pages.yml](.github/workflows/pages.yml)).
- Приватные материалы исследования в репозиторий не входят.
- Работа ведётся через Claude Code с набором агентов.

Живые люди на странице показываются только по имени.

# Paddock — для агентов

Точка входа в знания о проекте — [docs/README.md](docs/README.md) (OntoShip: читай индекс папки, потом документ).
Что делать дальше — [docs/plans/roadmap.md](docs/plans/roadmap.md): меняешь статус пункта в том же коммите, что и код.

- Морда: `web/` (своя инструкция по самовыкатке — `web/AGENTS.md`).
- Секреты только в `secrets/` (в `.gitignore`). В документах — «где лежит», не значения.
- После изменений морды — `tests/ui-tour.mjs` и `tests/grid-edges.mjs` должны быть зелёными.
- Новый документ: frontmatter с `node_type`, строка в `README.md` своей папки, хотя бы одна ссылка.

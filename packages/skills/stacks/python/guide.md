Work with the repository's existing Python layout, packaging tool (pip, uv, Poetry or Pipenv), supported Python version and import style. Treat pyproject.toml, setup.cfg, requirements files, tox.ini and nearby tests as the source of truth.

Keep changes narrow. Do not add a dependency, reformat files, or change packaging configuration unless the approved task requires it. Respect existing type hints and the package's import paths; do not fix an import by editing sys.path.

For bug fixes, add the smallest focused pytest test next to the existing tests, using the project's fixtures and naming (test_*.py). Run it with the provided focused command. Tests run without network access, so never rely on live HTTP, real databases or external services; use the project's existing fakes or monkeypatch.

Use the provided install, test and build commands exactly when present. If pytest or a test dependency is missing, report it rather than installing packages ad hoc. Distinguish failures caused by the change from failures that already exist on the approved baseline.

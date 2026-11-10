# Contributing

## Build from source offline

    pip download -d vendor -r requirements.txt   # once, while online
    pip install --no-index --find-links vendor -e .

## Tests

    python -m pytest tests/

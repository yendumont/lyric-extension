#!/bin/sh
# Joins src/*.js (in name order) into index.js, next to manifest.json.
cd "$(dirname "$0")" && cat src/*.js > index.js && node --check index.js && wc -l index.js

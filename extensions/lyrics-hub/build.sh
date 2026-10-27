#!/bin/sh
# Joins src/*.js (in name order) into ext/index.js.
cd "$(dirname "$0")" && mkdir -p ext && cat src/*.js > ext/index.js && node --check ext/index.js && wc -l ext/index.js

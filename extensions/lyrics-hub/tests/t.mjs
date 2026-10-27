import assert from "node:assert/strict";
import zlib from "node:zlib";
import { load, toLrc } from "./harness.mjs";
export const tests = [];
export const test = (name, fn) => tests.push([name, fn]);
export { assert, load, toLrc, zlib };

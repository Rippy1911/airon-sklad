/**
 * airon skład: one Worker serving the pages and a small JSON API. Static files (styles, fonts, photo.js) are Workers
 * Static Assets and never reach this code. Only the handler is exported here: Workers treats every named export of
 * the entry module as an entrypoint.
 */
import { makeHandler } from "./app.ts";

export default { fetch: makeHandler() };

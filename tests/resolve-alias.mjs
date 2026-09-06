/** Teaches Node the `~/` alias and extensionless imports the app uses. */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
register(pathToFileURL(new URL("./alias-hook.mjs", import.meta.url).pathname));

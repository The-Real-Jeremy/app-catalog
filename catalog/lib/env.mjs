/**
 * App-ception settings come from APPCEPTION_<NAME>; the older CATALOG_<NAME> (from when this was
 * "App Catalog") is still read as an alias, so an existing app.yaml keeps working. APPCEPTION_ wins.
 */
export const env = (name) => process.env[`APPCEPTION_${name}`] ?? process.env[`CATALOG_${name}`];

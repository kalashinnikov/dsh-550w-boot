/**
 * dsh-550w-boot — host half.
 *
 * Pure UI plugin: the empty apply exists so the plugin row appears in the
 * profile composition; the browser half ships via exports["./client"],
 * discovered through the package.json `dsh.client` declaration.
 */

function apply() {}
export { apply };

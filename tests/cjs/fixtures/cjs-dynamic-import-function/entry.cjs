const dynamicImport = new Function('specifier', 'return import(specifier)');

exports.value = dynamicImport('./dep.mjs').then((mod) => mod.value);

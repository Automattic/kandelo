/** Real optimized PHP input with a long chain of control-flow blocks. */
export function phpOptimizerCfgProbe(conditions: number): string {
  if (!Number.isSafeInteger(conditions) || conditions < 1 || conditions > 4096) {
    throw new RangeError("PHP CFG probe needs 1..4096 conditions");
  }
  return `<?php
function cfg_probe($value) {
    $sum = 0;
${Array.from({ length: conditions }, (_, index) =>
    `    if ($value === ${index}) { $sum += ${index + 1}; }`).join("\n")}
    return $sum;
}
header('Content-Type: application/json');
$configuration = opcache_get_configuration();
echo json_encode([
    'answer' => cfg_probe(${conditions - 1}),
    'miss' => cfg_probe(-1),
    'opcache' => extension_loaded('Zend OPcache'),
    'optimizationLevel' => $configuration['directives']['opcache.optimization_level'],
    'cacheFilePresent' => count(glob('/var/cache/opcache/*' . __FILE__ . '.bin')) > 0,
], JSON_THROW_ON_ERROR);
`;
}

export const PHP_OPTIMIZER_CFG_CONDITIONS = [96, 768] as const;
export const PHP_OPTIMIZER_DEFAULT_LEVEL = 0x7ffebfff;

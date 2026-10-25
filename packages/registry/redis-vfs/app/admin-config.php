<?php
// Use upstream configuration hooks; the application and its bundled clients
// remain unchanged. This temporary database is shared with invited peers.
declare(strict_types=1);

$config = require __DIR__ . '/config.dist.php';
$config['dashboards'] = [RobiNN\Pca\Dashboards\Redis\RedisDashboard::class];
$config['redisoptions']['client'] = 'predis';
$config['redis'][0]['name'] = 'Voting board';
$config['url'] = '../';
// Invited peers intentionally share a temporary database; the activity
// declaration explains that access instead of offering a server setup wizard.
$config['authwarning'] = false;
$config['tmpdir'] = '/tmp/phpcacheadmin';
$config['twigcache'] = '/tmp/phpcacheadmin/twig';
$config['metricsdir'] = '/tmp/phpcacheadmin/metrics';
return $config;

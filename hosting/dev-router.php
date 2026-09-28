<?php
declare(strict_types=1);

// PHP's local server ignores .htaccess. Mirror its allowlist without publishing private files.
$root = realpath($_SERVER['DOCUMENT_ROOT']);
$raw = explode('?', $_SERVER['REQUEST_URI'] ?? '/')[0];
$path = rawurldecode($raw);
$dynamic = $path === '/' || preg_match('~^/(?:index\.html|admin/?|admin\.html|registration\.html|privacy\.html|consent\.html|robots\.txt|sitemap\.xml|api/(?:admin(?:/.*)?|menu)|uploads(?:/.*)?|data/menu\.json)$~D', $path);
$blocked = preg_match('~(?:^|/)(?:\.|vosem-utra-private(?:/|$)|admin-data(?:/|$)|server(?:/|$)|node_modules(?:/|$)|hosting-tools(?:/|$)|site-build\.json(?:/|$))~i', $path) || str_contains($path, '\\') || str_contains($path, "\0") || preg_match('~\.(?:zip|log|bak|sql|env|ini|key|md|map)$~i', $path);
$file = $root ? realpath($root.'/'.$path) : false;
if (!$dynamic && !$blocked && $file && is_file($file) && str_starts_with($file, $root.DIRECTORY_SEPARATOR)) {
    if ($path === '/api/register.php') return false;
    if (in_array(strtolower(pathinfo($file, PATHINFO_EXTENSION)), ['js','css','json','svg','png','jpg','jpeg','webp','ico','woff2','txt'], true)) return false;
}
require $root.'/app.php';

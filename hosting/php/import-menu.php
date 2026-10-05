<?php
declare(strict_types=1);
// Server operator only. Place cached menu outside the public document root.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__.'/menu-import.php';
if (count($argv) !== 6 || $argv[5] !== '--test') {
    fwrite(STDERR, "Usage: php import-menu.php PRIVATE_DIRECTORY CACHED_MENU_JSON ORGANIZATION_ID GROUP_EXTERNAL_ID --test\n"); exit(1);
}
try {
    $directory = realpath($argv[1]); $sourceFile = realpath($argv[2]);
    if (!$directory || !is_dir($directory) || !$sourceFile || !is_file($sourceFile) || filesize($sourceFile) > 32 * 1024 * 1024) throw new RuntimeException('Invalid private directory or cached menu file.');
    if (!is_file($directory.'/admin-data/menu.json')) throw new RuntimeException('Open the existing site once before importing its menu.');
    $sourceBytes = file_get_contents($sourceFile);
    if ($sourceBytes === false || strlen($sourceBytes) > 32 * 1024 * 1024) throw new RuntimeException('Invalid cached menu size.');
    $source = json_decode($sourceBytes, true, 128, JSON_THROW_ON_ERROR);
    if (!is_array($source)) throw new RuntimeException('Invalid cached menu.');
    $menu = new CafeMenu($directory, []);
    $before = $menu->read();
    $result = $menu->importKdsGroup($source, $argv[3], $argv[4]);
    echo json_encode(['imported'=>true, 'changed'=>$before['revision'] !== $result['revision'], 'revision'=>$result['revision'], 'categories'=>count($result['categories']), 'items'=>count($result['items']), 'testOnly'=>true], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR).PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, ($error instanceof CafeMenuException ? $error->getMessage() : 'Import failed. Check the private directory, cached menu and permissions.').PHP_EOL); exit(1);
}

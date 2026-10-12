<?php
declare(strict_types=1);

// Optional operator CLI. On a deployed site this file lives beside menu.php.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once is_file(__DIR__.'/menu.php') ? __DIR__.'/menu.php' : dirname(__DIR__).'/hosting/php/menu.php';

if (count($argv) !== 3 || !in_array($argv[2], ['--dry-run', '--apply'], true)) {
    fwrite(STDERR, "Usage: php import-drinks.php PRIVATE_DIRECTORY --dry-run|--apply\n");
    exit(1);
}

try {
    $directory = realpath($argv[1]);
    if ($directory === false || !is_dir($directory) || !is_file($directory.'/admin-data/menu.json')) {
        throw new RuntimeException('An existing private directory with admin-data/menu.json is required.');
    }
    if (!is_file($directory.'/app/seed/drinks.json')) {
        throw new RuntimeException('The trusted app/seed/drinks.json file is missing. Upload the new application package first.');
    }
    // Do not call read(): an import preview must not initialize or migrate storage.
    $before = CafeStorage::readJson($directory.'/admin-data/menu.json');
    if (!is_array($before) || !is_int($before['revision'] ?? null)) throw new RuntimeException('The saved menu has no valid revision.');
    $dryRun = $argv[2] === '--dry-run';
    $menu = new CafeMenu($directory, ['manual_menu_enabled'=>true]);
    $result = $menu->importDrinks($before['revision'], $dryRun);
    $previousIds = array_column($before['items'], 'id');
    $addedIds = array_values(array_diff(array_column($result['items'], 'id'), $previousIds));
    echo json_encode([
        'dryRun'=>$dryRun,
        'changed'=>$result['revision'] !== $before['revision'],
        'previousRevision'=>$before['revision'],
        'revision'=>$result['revision'],
        'addedItems'=>count($addedIds),
        'addedIds'=>$addedIds,
        'categories'=>count($result['categories']),
        'items'=>count($result['items']),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR).PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage().PHP_EOL);
    exit(1);
}

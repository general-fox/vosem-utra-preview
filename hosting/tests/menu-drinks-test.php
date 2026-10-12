<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/php/drinks-import.php';
require_once dirname(__DIR__).'/php/private-data.php';

function drinkAssert(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function drinkRejects(callable $action, string $code): void {
    try { $action(); } catch (CafeMenuException $error) { drinkAssert($error->errorCode === $code, 'Unexpected error: '.$error->errorCode); return; }
    throw new RuntimeException('Expected '.$code);
}
function drinkDish(string $id = 'toast'): array { return ['id'=>$id, 'name'=>'Тост', 'description'=>'', 'price'=>350, 'category'=>'breakfast', 'image'=>'', 'published'=>true, 'availableForOrder'=>true, 'order'=>4]; }
$drink = ['section'=>' Кофе ', 'variants'=>[['volumeMl'=>250,'price'=>180.5],['volumeMl'=>350,'price'=>230]], 'addons'=>[['name'=>' Сироп ','price'=>40]], 'childFriendly'=>false, 'unknown'=>true];
$normalized = ['section'=>'Кофе', 'variants'=>[['volumeMl'=>250,'price'=>180.5],['volumeMl'=>350,'price'=>230]], 'addons'=>[['name'=>'Сироп','price'=>40]], 'childFriendly'=>false];
drinkAssert(cafe_normalize_drink($drink) == $normalized, 'Normalize trim and unknown fields');
drinkAssert(cafe_normalize_drink(null) === null, 'Optional drink');
drinkAssert(!array_key_exists('sectionOrder', cafe_normalize_drink($drink)), 'Legacy drink keeps optional subgroup order absent');
foreach ([0,3,10000] as $sectionOrder) drinkAssert(cafe_normalize_drink(array_replace($drink,['sectionOrder'=>$sectionOrder]))['sectionOrder'] === $sectionOrder, 'Subgroup order bounds accepted');
foreach ([-1,10001,1.5,'1',null,true,INF,NAN] as $sectionOrder) drinkRejects(fn()=>cafe_normalize_drink(array_replace($drink,['sectionOrder'=>$sectionOrder])), 'invalid_drink');
drinkAssert(cafe_normalize_drink(['section'=>'Детское','variants'=>[['volumeMl'=>1,'price'=>0]],'childFriendly'=>true])['addons'] === [], 'Default addons');
foreach ([-1,1000001,1.001,0.00000001,INF,NAN,'100'] as $price) drinkRejects(fn()=>cafe_normalize_drink(array_replace($drink,['variants'=>[['volumeMl'=>250,'price'=>$price]]])), 'invalid_drink');
foreach ([0,5001,250.5,'250'] as $volume) drinkRejects(fn()=>cafe_normalize_drink(array_replace($drink,['variants'=>[['volumeMl'=>$volume,'price'=>10]]])), 'invalid_drink');
foreach (['',str_repeat('a',81),"Кофе\nЧай","Кофе\u{0085}Чай"] as $section) drinkRejects(fn()=>cafe_normalize_drink(array_replace($drink,['section'=>$section])), 'invalid_drink');
foreach ([
    ['variants'=>[]], ['variants'=>[['volumeMl'=>250,'price'=>180],['volumeMl'=>250,'price'=>230]]],
    ['variants'=>array_map(fn($i)=>['volumeMl'=>$i,'price'=>1],range(1,11))],
    ['addons'=>null], ['addons'=>[['name'=>'Сироп','price'=>1],['name'=>' Сироп ','price'=>2]]],
    ['addons'=>array_map(fn($i)=>['name'=>'Добавка '.$i,'price'=>1],range(1,13))],
    ['addons'=>[['name'=>str_repeat('x',81),'price'=>1]]], ['addons'=>[['name'=>'Сироп','price'=>1.001]]], ['childFriendly'=>null], ['childFriendly'=>'true'],
] as $override) drinkRejects(fn()=>cafe_normalize_drink(array_replace($drink,$override)), 'invalid_drink');
$legacy = drinkDish();
drinkAssert(cafe_validate_items([$legacy])[0] === $legacy, 'Legacy item unchanged');
$latte = array_replace(drinkDish('latte'), ['name'=>'Латте','price'=>999,'category'=>'drinks','drink'=>$drink]);
$seed = ['categories'=>[['id'=>'drinks','name'=>'Напитки','parentId'=>null,'order'=>0]],'items'=>[$latte]];
$current = ['categories'=>cafe_default_categories(),'items'=>[$legacy],'revision'=>3,'source'=>['note'=>'keep metadata']];
$merged = cafe_merge_drinks_catalog($current,$seed);
drinkAssert($merged['items'][0] === $legacy && $merged['source'] === $current['source'], 'Import preserves existing records and metadata');
drinkAssert($merged['items'][1]['price'] == 180.5 && $merged['items'][1]['drink'] == $normalized && !$merged['items'][1]['availableForOrder'], 'Imported drink price and ordering');
drinkAssert($merged['items'][1]['order'] === 5 && $merged['categories'][2]['order'] === 2, 'Import appends display ordering');
drinkAssert(cafe_merge_drinks_catalog($merged,$seed) === $merged, 'Import idempotent');
$edited = $merged;
$edited['items'][1]['name'] = 'Наш латте'; $edited['items'][1]['drink']['variants'][0]['price'] = 310;
$edited['items'][1]['price'] = 310; $edited['items'][1]['hiddenOnSite'] = true;
$edited['items'][1]['drink']['section'] = 'Наш кофе'; $edited['items'][1]['drink']['sectionOrder'] = 2;
$edited['categories'][2]['name'] = 'Кофейная карта';
drinkAssert(cafe_merge_drinks_catalog($edited,$seed) === $edited, 'Reimport preserves all editor changes including hiding and category rename');
$rawCurrent = $current; $rawCurrent['items'][0]['image'] = 'menu-images/toast.jpg'; $rawCurrent['items'][0]['published'] = false; $rawCurrent['items'][0]['unknownField'] = 'keep';
drinkAssert(cafe_merge_drinks_catalog($rawCurrent,$seed)['items'][0] === $rawCurrent['items'][0], 'Validation never rewrites original photos, flags or unknown fields');
drinkRejects(fn()=>cafe_merge_drinks_catalog(array_replace($current,['items'=>[drinkDish('latte')]]),$seed), 'drink_import_conflict');
$nested = $seed; $nested['categories'][]=['id'=>'child','name'=>'Кофе','parentId'=>'drinks','order'=>1];
drinkRejects(fn()=>cafe_merge_drinks_catalog($current,$nested), 'invalid_drinks_seed');

$fixture = dirname(__DIR__,2).'/.php-preview/drink-tests-'.bin2hex(random_bytes(6));
mkdir($fixture.'/app/seed',0700,true); mkdir($fixture.'/admin-data',0700,true);
$menuFile = $fixture.'/admin-data/menu.json';
$password = 'test-drinks-password-at-least-24';
$config = ['manual_menu_enabled'=>true,'delivery_enabled'=>false,'keeper_enabled'=>false,'allow_http_dev'=>true,'public_origin'=>'http://127.0.0.1:9999','auth_mode'=>'password','encryption_key'=>bin2hex(random_bytes(32)),'bootstrap_password_hash'=>CafeAuth::hashPassword($password)];
try {
    CafeStorage::atomicJson($menuFile,$current); CafeStorage::atomicJson($fixture.'/app/seed/drinks.json',$seed);
    file_put_contents($fixture.'/admin-data/untouched.txt','private sentinel');
    $menu = new CafeMenu($fixture,$config);
    $raw = file_get_contents($menuFile);
    $preview = $menu->importDrinks(3,true);
    drinkAssert($preview['revision'] === 4 && count($preview['items']) === 2, 'Dry run shows projected revision');
    drinkAssert(file_get_contents($menuFile) === $raw && glob($fixture.'/admin-data/menu-before-drinks-import-*') === [], 'Dry run never saves or backs up');
    drinkRejects(fn()=>$menu->importDrinks(2), 'conflict');
    drinkRejects(fn()=>(new CafeMenu($fixture,array_replace($config,['manual_menu_enabled'=>false])))->importDrinks(3), 'manual_menu_disabled');
    $saved = $menu->importDrinks(3);
    drinkAssert($saved === $preview, 'Apply matches preview');
    $backups = glob($fixture.'/admin-data/menu-before-drinks-import-*');
    drinkAssert(count($backups) === 1 && file_get_contents($backups[0]) === $raw, 'Exact raw backup before import');
    $afterImportBytes = file_get_contents($menuFile);
    drinkAssert($menu->importDrinks(4) == $saved && file_get_contents($menuFile) === $afterImportBytes && count(glob($fixture.'/admin-data/menu-before-drinks-import-*')) === 1, 'Repeated import does not write, increment or back up');
    $loaded = $menu->read();
    drinkAssert($loaded['items'][1]['drink'] == $normalized && $loaded['revision'] === 4, 'Drink survives durable reload');
    $public = $menu->catalog();
    drinkAssert($public['items'][1]['drink'] == $normalized && !$public['items'][1]['availableForOrder'], 'Public menu preserves choices and disabled ordering');
    $loaded['items'][1]['drink']['variants'][0]['price']=280.25; $loaded['items'][1]['drink']['childFriendly']=true;
    $loaded['items'][1]['drink']['section']='Наш кофе'; $loaded['items'][1]['drink']['sectionOrder']=2;
    $saved = $menu->update($loaded['items'],4,$loaded['categories']);
    drinkAssert($saved['items'][1]['price'] == 280.25 && $saved['items'][1]['drink']['childFriendly'], 'Editor changes round trip with canonical price');
    drinkAssert($saved['items'][1]['drink']['section'] === 'Наш кофе' && $saved['items'][1]['drink']['sectionOrder'] === 2, 'Subgroup rename and ordering survive menu update');
    drinkAssert((new CafeMenu($fixture,$config))->read()['items'][1]['drink'] === $saved['items'][1]['drink'], 'Subgroup rename and ordering survive durable reload');
    drinkAssert($menu->catalog()['items'][1]['drink'] === $saved['items'][1]['drink'], 'Public menu carries renamed and ordered subgroup');
    $raw = file_get_contents($menuFile); $invalid = $saved['items']; $invalid[1]['drink']['variants'][1]['volumeMl']=250;
    drinkRejects(fn()=>$menu->update($invalid,5,$saved['categories']), 'invalid_drink');
    $invalid = $saved['items']; $invalid[1]['drink']['sectionOrder']=-1;
    drinkRejects(fn()=>$menu->update($invalid,5,$saved['categories']), 'invalid_drink');
    drinkAssert(file_get_contents($menuFile) === $raw && file_get_contents($fixture.'/admin-data/untouched.txt') === 'private sentinel', 'Failed save and import leave unrelated private state untouched');

    $_SERVER['REQUEST_METHOD']='POST'; $_SERVER['HTTP_ORIGIN']=$config['public_origin']; $_COOKIE=[];
    ob_start(); $menu->dispatch('/api/admin/menu/drinks-import','POST'); $response=json_decode(ob_get_clean(),true);
    drinkAssert(http_response_code() === 401 && $response['code'] === 'unauthorized', 'Import requires login');
    $session = $menu->auth->login(['username'=>'admin','password'=>$password],'test');
    $_COOKIE['vosem_admin']=$session['token']; $_SERVER['HTTP_X_CSRF_TOKEN']='incorrect';
    ob_start(); $menu->dispatch('/api/admin/menu/drinks-import','POST'); $response=json_decode(ob_get_clean(),true);
    drinkAssert(http_response_code() === 403 && $response['code'] === 'csrf', 'Import requires CSRF');
    $_SERVER['HTTP_X_CSRF_TOKEN']=$session['csrfToken']; $_SERVER['HTTP_ORIGIN']='http://elsewhere.test';
    ob_start(); $menu->dispatch('/api/admin/menu/drinks-import','POST'); $response=json_decode(ob_get_clean(),true);
    drinkAssert(http_response_code() === 403 && $response['code'] === 'origin', 'Import requires same origin');
    drinkAssert(file_get_contents($menuFile) === $raw, 'Rejected imports cannot change menu');

    file_put_contents($fixture.'/admin-config.php','<?php return '.var_export(['publicOrigin'=>'https://test.example','encryptionKey'=>$config['encryption_key']],true).';');
    cafe_export_private($fixture,$fixture.'/menu.cafebackup',$fixture.'/menu.key',false);
    cafe_import_private($fixture.'/menu.cafebackup',$fixture.'/menu.key',$fixture.'/restored','https://restore.example');
    $restored=(new CafeMenu($fixture.'/restored',[]))->read();
    drinkAssert($restored['items'][1]['drink'] === $saved['items'][1]['drink'] && $restored['items'][1]['price'] == 280.25, 'Encrypted export and restore retain beverage metadata');
} finally {
    $resolved=realpath($fixture); $allowed=realpath(dirname(__DIR__,2).'/.php-preview');
    if ($resolved && $allowed && str_starts_with(strtolower($resolved),strtolower($allowed.DIRECTORY_SEPARATOR))) {
        $entries=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($entries as $entry) { if ($entry->isDir() && !$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
        rmdir($resolved);
    }
}
echo 'PASS beverage validation, additive import, durable edits, public JSON, backup/restore and import access controls'.PHP_EOL;

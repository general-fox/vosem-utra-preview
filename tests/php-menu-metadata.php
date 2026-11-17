<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/hosting/php/menu.php';
require_once dirname(__DIR__).'/hosting/php/private-data.php';

function metadataAssert(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function metadataRejects(callable $action): void {
    try { $action(); } catch (CafeMenuException $error) { metadataAssert($error->status === 400 && $error->errorCode === 'invalid_item', 'Expected invalid item rejection'); return; }
    throw new RuntimeException('Invalid dish metadata was accepted');
}
$dish=['id'=>'toast','name'=>'Тост','description'=>'Хлеб, яйцо и зелень','price'=>450,'category'=>'breakfast','image'=>'','published'=>true,'availableForOrder'=>true,'order'=>0];
metadataAssert(cafe_validate_items([$dish])[0] === $dish, 'Legacy record stays unchanged');
$edited=array_replace($dish,['nutrition'=>"  420 ккал\nБ: 14 г, Ж: 22 г, У: 39 г  ",'allergens'=>"  Яйцо, молоко\nГлютен  "]);
$expected=['nutrition'=>"420 ккал\nБ: 14 г, Ж: 22 г, У: 39 г",'allergens'=>"Яйцо, молоко\nГлютен"];
$valid=cafe_validate_items([$edited])[0];
foreach ($expected as $key=>$value) metadataAssert($valid[$key] === $value, 'Trimmed '.$key);
metadataAssert($valid['description'] === $dish['description'], 'Composition stays separate');
foreach (['nutrition'=>500,'allergens'=>1000] as $key=>$limit) {
    foreach ([str_repeat('я',$limit),str_repeat('🍽',intdiv($limit,2))] as $text) metadataAssert(cafe_validate_items([array_replace($dish,[$key=>$text])])[0][$key] === $text,'Accepted exact limit');
    foreach ([null,false,123,[],['value'=>'x'],"bad\x00value","bad\x7fvalue",str_repeat('я',$limit+1),str_repeat('🍽',intdiv($limit,2)+1),str_repeat(' ',$limit+1)] as $value) metadataRejects(fn()=>cafe_validate_items([array_replace($dish,[$key=>$value])]));
    $single=cafe_validate_items([array_replace($dish,[$key=>''])])[0];
    metadataAssert($single[$key] === '' && !array_key_exists($key === 'nutrition'?'allergens':'nutrition',$single),'Optional fields stay independent');
}
$base=dirname(__DIR__).'/.php-preview';
$fixture=$base.'/dish-metadata-'.bin2hex(random_bytes(6));
mkdir($fixture.'/admin-data',0700,true);
$config=['manual_menu_enabled'=>true,'delivery_enabled'=>false,'keeper_enabled'=>false,'allow_http_dev'=>true,'public_origin'=>'http://127.0.0.1:9999','auth_mode'=>'password','encryption_key'=>bin2hex(random_bytes(32)),'bootstrap_password_hash'=>CafeAuth::hashPassword('metadata-test-password-24-characters')];
try {
    $menuFile=$fixture.'/admin-data/menu.json';
    CafeStorage::atomicJson($menuFile,['categories'=>cafe_default_categories(),'items'=>[$dish],'revision'=>1]);
    $menu=new CafeMenu($fixture,$config);
    $current=$menu->read();
    $current['items'][0]=$edited;
    $saved=$menu->update($current['items'],$current['revision'],$current['categories']);
    metadataAssert((new CafeMenu($fixture,$config))->read() === $saved, 'Dish metadata survives reopening storage');
    $public=$menu->catalog()['items'][0];
    foreach ($expected as $key=>$value) metadataAssert($public[$key] === $value, 'Public catalog exposes '.$key);
    $before=file_get_contents($menuFile);
    foreach (['nutrition'=>str_repeat('я',501),'allergens'=>['unexpected'=>'object']] as $key=>$value) {
        $invalid=$saved['items']; $invalid[0][$key]=$value;
        metadataRejects(fn()=>$menu->update($invalid,$saved['revision'],$saved['categories']));
        metadataAssert(file_get_contents($menuFile) === $before, 'Rejected metadata never changes storage');
    }
    file_put_contents($fixture.'/admin-config.php','<?php return '.var_export(['publicOrigin'=>'https://metadata.example','encryptionKey'=>$config['encryption_key']],true).';');
    $menu->auth->login(['username'=>'admin','password'=>'metadata-test-password-24-characters'],'test');
    cafe_export_private($fixture,$fixture.'/menu.cafebackup',$fixture.'/menu.key',false);
    cafe_import_private($fixture.'/menu.cafebackup',$fixture.'/menu.key',$fixture.'/restored','https://restore.example');
    $restored=(new CafeMenu($fixture.'/restored',[]))->read();
    foreach ($expected as $key=>$value) metadataAssert($restored['items'][0][$key] === $value, 'Encrypted transfer restores '.$key);
    $clearedItems=$saved['items']; $clearedItems[0]['nutrition']=" \n "; $clearedItems[0]['allergens']='';
    $cleared=$menu->update($clearedItems,$saved['revision'],$saved['categories']);
    metadataAssert($cleared['items'][0]['nutrition'] === '' && $cleared['items'][0]['allergens'] === '', 'Explicit clear stores empty strings');
    $public=$menu->catalog()['items'][0];
    metadataAssert($public['nutrition'] === '' && $public['allergens'] === '', 'Cleared fields are public');
} finally {
    $resolved=realpath($fixture); $allowed=realpath($base);
    if ($resolved && $allowed && str_starts_with(strtolower($resolved),strtolower($allowed.DIRECTORY_SEPARATOR))) {
        $entries=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($entries as $entry) { if ($entry->isDir() && !$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
        rmdir($resolved);
    }
}
echo 'PASS PHP dish metadata validation, persistence, public catalog, clearing and encrypted transfer'.PHP_EOL;

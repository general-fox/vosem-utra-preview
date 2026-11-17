<?php
declare(strict_types=1);
require_once dirname(__DIR__).'/hosting/php/menu.php';
require_once dirname(__DIR__).'/hosting/php/private-data.php';

function galleryAssert(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function galleryRejects(callable $action): void {
    try { $action(); } catch (CafeMenuException $error) { galleryAssert($error->status === 400, 'Expected validation rejection'); return; }
    throw new RuntimeException('Expected invalid album to be rejected');
}
$dish=['id'=>'toast','name'=>'Тост','description'=>'','price'=>450,'category'=>'breakfast','image'=>'/menu-images/old.jpg','published'=>true,'availableForOrder'=>true,'order'=>0];
galleryAssert(cafe_validate_items([$dish])[0] === $dish, 'Legacy single-photo record unchanged');
galleryAssert(cafe_menu_images($dish) === ['/menu-images/old.jpg'], 'Legacy photo exposed as gallery');
$gallery=array_replace($dish,['images'=>['uploads/second.png','/uploads/first.jpg']]);
$validated=cafe_validate_items([$gallery])[0];
galleryAssert($validated['images'] === ['/uploads/second.png','/uploads/first.jpg'] && $validated['image'] === '/uploads/second.png', 'Ordered paths and cover normalization');
galleryAssert(cafe_validate_items([array_replace($dish,['images'=>[]])])[0]['image'] === '', 'Explicit empty gallery clears cover');
galleryAssert(count(cafe_menu_images(array_replace($dish,['images'=>array_map(fn($i)=>'/uploads/p'.$i.'.jpg',range(1,10))]))) === 10, '10 images allowed');
foreach ([null,'bad',array_fill(0,11,'/uploads/a.jpg'),[''],[null],['https://remote.test/a.jpg'],['/uploads/../a.jpg'],['/uploads/a.jpg?x=1'],['/uploads/a.svg'],['/uploads/a.jpg','uploads/a.jpg']] as $images) {
    galleryRejects(fn()=>cafe_validate_items([array_replace($dish,['images'=>$images])]));
}
$base=dirname(__DIR__).'/.php-preview';
$fixture=$base.'/gallery-'.bin2hex(random_bytes(6));
mkdir($fixture.'/admin-data/uploads',0700,true);
mkdir($fixture.'/app/seed',0700,true);
$config=['manual_menu_enabled'=>true,'delivery_enabled'=>false,'keeper_enabled'=>false,'allow_http_dev'=>true,'public_origin'=>'http://127.0.0.1:9999','auth_mode'=>'password','encryption_key'=>bin2hex(random_bytes(32)),'bootstrap_password_hash'=>CafeAuth::hashPassword('gallery-test-password-24-characters')];
try {
    $menuFile=$fixture.'/admin-data/menu.json';
    CafeStorage::atomicJson($menuFile,['categories'=>cafe_default_categories(),'items'=>[$dish],'revision'=>1]);
    file_put_contents($fixture.'/admin-data/untouched.txt','sentinel');
    $menu=new CafeMenu($fixture,$config);
    $current=$menu->read();
    $current['items'][0]['images']=$gallery['images'];
    $saved=$menu->update($current['items'],$current['revision'],$current['categories']);
    galleryAssert($saved['items'][0]['images'] === $validated['images'], 'Save stores gallery');
    $reloaded=(new CafeMenu($fixture,$config))->read();
    galleryAssert($reloaded === $saved, 'Gallery survives reopening storage');
    galleryAssert($menu->catalog()['items'][0]['images'] === $validated['images'], 'Public catalog carries all photos');
    $current=$saved;
    $current['items'][0]['images']=array_reverse($current['items'][0]['images']);
    $saved=$menu->update($current['items'],$current['revision'],$current['categories']);
    galleryAssert($saved['items'][0]['image'] === '/uploads/first.jpg', 'Reorder changes cover');
    $before=file_get_contents($menuFile);
    $invalid=$saved['items']; $invalid[0]['images']=['/uploads/../outside.jpg'];
    galleryRejects(fn()=>$menu->update($invalid,$saved['revision'],$saved['categories']));
    galleryAssert(file_get_contents($menuFile) === $before, 'Rejected album never changes storage');

    file_put_contents($fixture.'/admin-config.php','<?php return '.var_export(['publicOrigin'=>'https://gallery.example','encryptionKey'=>$config['encryption_key']],true).';');
    file_put_contents($fixture.'/admin-data/uploads/first.jpg','fixture-photo-one');
    file_put_contents($fixture.'/admin-data/uploads/second.png','fixture-photo-two');
    $menu->auth->login(['username'=>'admin','password'=>'gallery-test-password-24-characters'],'test');
    cafe_export_private($fixture,$fixture.'/menu.cafebackup',$fixture.'/menu.key',false);
    cafe_import_private($fixture.'/menu.cafebackup',$fixture.'/menu.key',$fixture.'/restored','https://restore.example');
    $restored=(new CafeMenu($fixture.'/restored',[]))->read();
    galleryAssert($restored['items'][0]['images'] === $saved['items'][0]['images'], 'Encrypted backup restores order');
    galleryAssert(file_get_contents($fixture.'/restored/admin-data/uploads/second.png') === 'fixture-photo-two', 'Backup transfers secondary photograph');
    unlink($fixture.'/admin-data/uploads/second.png');
    try { cafe_snapshot($fixture,false); throw new LogicException('Missing secondary photo was accepted'); }
    catch (RuntimeException $error) { galleryAssert($error->getMessage() === 'A menu photograph is missing.', 'Backup refuses missing secondary image'); }

    $current=$saved; $current['items'][0]['images']=[];
    $cleared=$menu->update($current['items'],$current['revision'],$current['categories']);
    galleryAssert($cleared['items'][0]['images'] === [] && $cleared['items'][0]['image'] === '', 'Remove every photo and clear legacy cover');
    galleryAssert(file_get_contents($fixture.'/admin-data/uploads/first.jpg') === 'fixture-photo-one' && file_get_contents($fixture.'/admin-data/untouched.txt') === 'sentinel', 'Editing gallery never deletes shared uploads or unrelated state');
} finally {
    $resolved=realpath($fixture); $allowed=realpath($base);
    if ($resolved && $allowed && str_starts_with(strtolower($resolved),strtolower($allowed.DIRECTORY_SEPARATOR))) {
        $entries=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($entries as $entry) { if ($entry->isDir() && !$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
        rmdir($resolved);
    }
}
echo 'PASS PHP gallery validation, persistence, reordering, clearing and encrypted photo transfer'.PHP_EOL;

<?php
declare(strict_types=1);

require_once dirname(__DIR__).'/php/site.php';

function check(bool $condition, string $message): void { if (!$condition) throw new RuntimeException($message); }
function rejects(callable $operation, string $code): void {
    try { $operation(); } catch (CafeMenuException $error) { check($error->errorCode === $code, 'Unexpected error: '.$error->errorCode); return; }
    throw new RuntimeException('Expected error '.$code);
}
function item(string $id = 'toast'): array { return ['id'=>$id, 'name'=>'Тост <кофе> & сыр', 'description'=>'Описание "фото" $1 </script><script>bad()</script>', 'price'=>123.45, 'category'=>'eggs', 'image'=>'/menu-images/toast.jpg', 'published'=>true, 'order'=>2]; }
function template(): string {
    return '<!doctype html><html><head><title>Old page</title><meta name="description" content="Old description"><meta name="robots" content="noindex"><script nonce="stale">window.test=1</script></head><body><div data-dish-grid></div><section data-extra-section hidden><div data-dish-extras></div></section><p data-menu-empty hidden>Нет блюд</p><span data-menu-count>0</span></body></html>';
}
function fixture(string $root, string $name): string {
    $private = $root.'/'.$name.'/vosem-utra-private';
    mkdir($private.'/app/seed', 0700, true); mkdir($private.'/app/templates', 0700, true);
    file_put_contents($private.'/app/seed/menu.json', json_encode(['items'=>[item()]], JSON_THROW_ON_ERROR));
    foreach (['index','admin','registration','privacy','consent'] as $page) file_put_contents($private.'/app/templates/'.$page.'.html', template());
    return $private;
}
function removeFixture(string $root, string $allowedRoot): void {
    $resolved = realpath($root); $allowed = realpath($allowedRoot);
    if (!$resolved || !$allowed || !str_starts_with(strtolower($resolved), strtolower($allowed.DIRECTORY_SEPARATOR))) throw new RuntimeException('Unsafe fixture cleanup');
    $entries = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($resolved, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($entries as $entry) { if ($entry->isDir() && !$entry->isLink()) rmdir($entry->getPathname()); else unlink($entry->getPathname()); }
    rmdir($resolved);
}

if (($argv[1] ?? '') === '--race-worker') {
    $menu = new CafeMenu($argv[2], ['public_origin'=>'https://vosem-utra.ru']);
    $deadline = microtime(true) + 10;
    while (!is_file($argv[3])) { if (microtime(true) > $deadline) exit(2); usleep(1000); }
    try { $menu->update([item($argv[4])], 1); echo '200'; }
    catch (CafeMenuException $error) { echo (string)$error->status; }
    exit;
}

$base = dirname(__DIR__, 2).'/.php-preview';
if (!is_dir($base)) mkdir($base, 0700, true);
$root = $base.'/menu-site-tests-'.bin2hex(random_bytes(6)); mkdir($root, 0700);
$passed = [];
try {
    $valid = cafe_validate_items([item()]);
    check($valid[0]['price'] === 123.45, 'Decimal price retained');
    check($valid[0]['availableForOrder'] === true, 'Legacy availability defaults to true');
    check(cafe_validate_items([array_replace(item(), ['availableForOrder'=>false])])[0]['availableForOrder'] === false, 'Explicit unavailable value is preserved');
    foreach ([null, 0, 1, 'false', [], new stdClass()] as $invalidAvailability) rejects(static fn()=>cafe_validate_items([array_replace(item(), ['availableForOrder'=>$invalidAvailability])]), 'invalid_availability');
    foreach ([['price'=>'123'],['price'=>1.001],['price'=>INF],['published'=>1],['order'=>-1],['category'=>'unknown'],['image'=>'https://external.test/a.jpg'],['image'=>'/uploads/../secret.jpg'],['image'=>'/uploads/a.php'],['name'=>"a\0b"]] as $change) {
        try { cafe_validate_items([array_replace(item(), $change)]); throw new LogicException('Accepted invalid item'); }
        catch (CafeMenuException $error) { check($error->status === 400, 'Validation rejects invalid item'); }
    }
    rejects(static fn()=>cafe_validate_items([item(), item()]), 'invalid_id');
    rejects(static fn()=>cafe_validate_items(array_fill(0, 301, item())), 'invalid_items');
    check(cafe_validate_items([array_replace(item(), ['name'=>str_repeat('😀', 80)])])[0]['name'] !== '', 'UTF16 boundary accepts 160 units');
    rejects(static fn()=>cafe_validate_items([array_replace(item(), ['name'=>str_repeat('😀', 81)])]), 'invalid_item');
    $passed[] = 'item contract and hostile input validation';

    $private = fixture($root, 'menu'); $config = ['public_origin'=>'https://vosem-utra.ru'];
    $menu = new CafeMenu($private, $config);
    check($menu->read()['revision'] === 1, 'Seed initialized once');
    $updated = $menu->update([array_replace(item(), ['name'=>'Свежий завтрак', 'published'=>false])], 1);
    check($updated['revision'] === 2, 'Revision increments');
    rejects(static fn()=>$menu->update([item()], 1), 'conflict');
    $restarted = new CafeMenu($private, $config);
    check($restarted->read()['items'][0]['name'] === 'Свежий завтрак', 'Changes survive a fresh instance');
    check($restarted->published() === [], 'Hidden item excluded');
    file_put_contents($private.'/admin-data/menu.json', '{corrupt');
    rejects(static fn()=>$restarted->read(), 'menu_unavailable');
    check(file_get_contents($private.'/admin-data/menu.json') === '{corrupt', 'Corruption cannot reset to seed');
    $passed[] = 'durable menu, revisions, hidden positions and corruption fail closed';

    $availabilityPrivate = fixture($root, 'availability'); $availabilityMenu = new CafeMenu($availabilityPrivate, $config);
    $legacyJson = json_encode(['items'=>[item()], 'revision'=>17], JSON_THROW_ON_ERROR);
    file_put_contents($availabilityPrivate.'/admin-data/menu.json', $legacyJson);
    check($availabilityMenu->read()['items'][0]['availableForOrder'] === true, 'Saved legacy catalog defaults on read');
    check(file_get_contents($availabilityPrivate.'/admin-data/menu.json') === $legacyJson, 'Legacy read does not rewrite the stored catalog');
    $availabilitySaved = $availabilityMenu->update([array_replace(item(), ['availableForOrder'=>false]), array_replace(item('hidden'), ['published'=>false,'availableForOrder'=>true])], 17);
    $catalog = $availabilityMenu->catalog();
    check($catalog['revision'] === $availabilitySaved['revision'] && $catalog['revision'] === 18, 'Published catalog revision matches authoritative save');
    check(count($catalog['items']) === 1 && $catalog['items'][0]['published'] && !$catalog['items'][0]['availableForOrder'], 'Visible unavailable dish is retained; hidden dish is omitted');
    check((new CafeMenu($availabilityPrivate, $config))->catalog() === $catalog, 'Availability and revision survive reload');
    $_SERVER['REQUEST_METHOD']='GET';
    foreach (['/api/menu','/data/menu.json'] as $route) {
        ob_start(); $availabilityMenu->dispatch($route, 'GET'); $response=json_decode(ob_get_clean(), true, 512, JSON_THROW_ON_ERROR);
        check($response === $catalog, 'Public route returns the complete current catalog snapshot');
    }
    $passed[] = 'independent order availability, legacy compatibility and public catalog revision';

    $racePrivate = fixture($root, 'race'); (new CafeMenu($racePrivate, $config))->read();
    $gate = $root.'/race-go'; $workers = [];
    for ($index=0; $index<4; $index++) {
        $process = proc_open([PHP_BINARY, __FILE__, '--race-worker', $racePrivate, $gate, 'winner-'.$index], [0=>['pipe','r'],1=>['pipe','w'],2=>['pipe','w']], $pipes);
        check(is_resource($process), 'Race worker started'); fclose($pipes[0]); $workers[] = [$process, $pipes];
    }
    file_put_contents($gate, 'go'); $statuses = [];
    foreach ($workers as [$process,$pipes]) { $statuses[] = stream_get_contents($pipes[1]); $errors=stream_get_contents($pipes[2]); fclose($pipes[1]); fclose($pipes[2]); check(proc_close($process) === 0 && $errors === '', 'Race worker completed'); }
    sort($statuses); check($statuses === ['200','409','409','409'], 'Exactly one stale-revision concurrent writer wins');
    check((new CafeMenu($racePrivate, $config))->read()['revision'] === 2, 'Single committed revision after race');
    $passed[] = 'cross-process file lock prevents concurrent lost updates';

    $items = [item(), array_replace(item('hidden'), ['name'=>'SECRET HIDDEN DISH', 'published'=>false]), array_replace(item('extra'), ['name'=>'Каша', 'image'=>'', 'price'=>120.5, 'order'=>1])];
    $html = cafe_transform_page(template(), 'index', true, $items, ['google_verification'=>'safe"<tag>']);
    check(str_contains($html, '&lt;кофе&gt; &amp; сыр'), 'Menu escaped in HTML');
    check(!str_contains($html, '<script>bad()</script>'), 'Description cannot close a script');
    check(!str_contains($html, 'SECRET HIDDEN DISH'), 'Hidden dish absent from HTML and schema');
    check(str_contains($html, '2 блюда') && str_contains($html, '123,45') && str_contains($html, '120,5'), 'Count and decimal money rendered');
    check(str_contains($html, 'href="https://vosem-utra.ru/"') && str_contains($html, 'https://vosem-utra.ru/social-cover.webp'), 'Stable canonical and social photo');
    preg_match('~<script type="application/ld\+json" id="cafe-structured-data">(.*?)</script>~s', $html, $schemaMatch);
    $schema = json_decode($schemaMatch[1], true, 512, JSON_THROW_ON_ERROR);
    check($schema['telephone'] === '+79851308106' && $schema['@type'] === 'CafeOrCoffeeShop', 'Factual cafe schema');
    $schemaNames = [];
    foreach ($schema['hasMenu']['hasMenuSection'] as $section) foreach ($section['hasMenuItem'] as $dish) $schemaNames[] = $dish['name'];
    check(in_array(item()['name'], $schemaNames, true), 'Escaped JSON roundtrips original dish name');
    $again = cafe_transform_page($html, 'index', true, [array_replace(item(), ['name'=>'Changed after build'])]);
    check(substr_count($again, 'id="cafe-structured-data"') === 1 && !str_contains($again, 'Каша') && str_contains($again, 'Changed after build'), 'Live transform replaces old menu and schema');
    $empty = cafe_transform_page($again, 'index', true, []);
    check(str_contains($empty, 'data-menu-empty>') && str_contains($empty, '0 блюд'), 'Empty menu state is visible');
    foreach (['admin','registration','privacy','consent'] as $page) check(str_contains(cafe_transform_page(template(), $page, true), 'content="noindex,'), 'Utility noindex');
    $preview = cafe_transform_page($html, 'index', false, $items);
    check(str_contains($preview, 'noindex, nofollow') && !str_contains($preview, 'rel="canonical"') && !str_contains($preview, 'cafe-structured-data'), 'Preview strips production metadata');
    $nonceOne = cafe_secure_html($html, 'index'); $nonceTwo = cafe_secure_html($html, 'index');
    preg_match_all('~<script\b[^>]*\bnonce="([^"]+)"~', $nonceOne, $nonces);
    check(count($nonces[1]) === 2 && count(array_unique($nonces[1])) === 1 && !str_contains($nonceOne, 'nonce="stale"') && $nonceOne !== $nonceTwo, 'Unique per-response nonce applied to every script');
    $availableCard = cafe_dish_html(item());
    $unavailableCard = cafe_dish_html(array_replace(item('unavailable'), ['availableForOrder'=>false, 'image'=>'']));
    check(str_contains($availableCard, 'data-cart-add="toast"') && str_contains($availableCard, 'aria-label="В корзину: ') && !str_contains($availableCard, ' disabled'), 'Legacy photo card has accessible enabled cart control');
    check(str_contains($unavailableCard, 'data-cart-add="unavailable"') && str_contains($unavailableCard, 'aria-label="Временно недоступно: ') && str_contains($unavailableCard, ' disabled>Временно недоступно</button>'), 'Unavailable text card has a disabled cart control');
    $passed[] = 'live initial HTML, escaped JSON-LD, metadata, preview and nonce transforms';

    $imagePrivate = fixture($root, 'images'); $imageMenu = new CafeMenu($imagePrivate, $config);
    $pixel = imagecreatetruecolor(2,2); imagefill($pixel, 0, 0, imagecolorallocate($pixel, 230, 120, 10));
    foreach (['image/png'=>'png','image/jpeg'=>'jpeg','image/webp'=>'webp'] as $mime => $encoder) {
        ob_start(); ('image'.$encoder)($pixel); $bytes=ob_get_clean();
        $url = $imageMenu->storeImage($bytes.'<?php ECHO PRIVATE_TRAILER; ?>', $mime);
        check((bool)preg_match('~^/uploads/[a-f0-9-]{36}\.(?:jpg|png|webp)$~D', $url), 'Generated safe image path');
        $saved = file_get_contents($imagePrivate.'/admin-data'.$url);
        check(!str_contains($saved, 'PRIVATE_TRAILER') && getimagesizefromstring($saved)['mime'] === $mime && imagecreatefromstring($saved) !== false, 'Actual decoding removes executable/trailing payload');
    }
    imagedestroy($pixel);
    rejects(static fn()=>$imageMenu->storeImage('<?php bad(); ?>', 'image/png'), 'invalid_image');
    rejects(static fn()=>$imageMenu->storeImage(str_repeat('x', 5*1024*1024+1), 'image/png'), 'too_large');
    rejects(static fn()=>$imageMenu->storeImage('<svg></svg>', 'image/svg+xml'), 'invalid_image_type');
    $passed[] = 'GD validates and strips uploaded payloads outside the document root';

    $settingsPrivate = fixture($root, 'settings');
    file_put_contents($settingsPrivate.'/admin-config.php', '<?php return '.var_export(['publicOrigin'=>'https://test.example','username'=>'owner','passwordHash'=>'synthetic-hash','encryptionKey'=>'synthetic-key','googleVerification'=>'verify'], true).';');
    putenv('CAFE_ENV'); $_SERVER['REMOTE_ADDR']='127.0.0.1'; $_SERVER['HTTP_HOST']='localhost:8123';
    $settings = cafe_site_config($settingsPrivate);
    check($settings['production'] && !$settings['indexing'] && $settings['bootstrap_username']==='owner' && $settings['google_verification']==='verify', 'Test HTTPS domain keeps production auth with noindex and aliases');
    putenv('CAFE_ENV=development'); $dev = cafe_site_config($settingsPrivate);
    check(!$dev['production'] && !$dev['indexing'] && $dev['allow_http_dev'] && $dev['public_origin']==='http://localhost:8123', 'Explicit loopback development');
    $_SERVER['REMOTE_ADDR']='192.0.2.1';
    try { cafe_site_config($settingsPrivate); throw new LogicException('Remote development accepted'); } catch (RuntimeException $error) { check(!($error instanceof LogicException), 'Remote development rejected'); }
    putenv('CAFE_ENV');
    $passed[] = 'config aliases, test-domain noindex, and loopback-only development';

    $httpPrivate = fixture($root, 'http-boundaries'); $httpMenu = new CafeMenu($httpPrivate, $config);
    $_SERVER['REQUEST_METHOD']='POST'; $_SERVER['HTTP_ORIGIN']='https://vosem-utra.ru'; $_SERVER['HTTP_X_FORWARDED_PROTO']='https'; unset($_SERVER['HTTPS']);
    ob_start(); $httpMenu->dispatch('/api/admin/login', 'POST'); $refusal=json_decode(ob_get_clean(), true, 512, JSON_THROW_ON_ERROR);
    check(http_response_code() === 400 && $refusal['code'] === 'https_required', 'Production credentials refused over actual HTTP despite forwarded header');
    check(!is_file($httpPrivate.'/admin-data/auth-state.json'), 'Cleartext request cannot touch auth state');
    $_SERVER['REQUEST_METHOD']='GET'; $_SERVER['REQUEST_URI']='/'; unset($_SERVER['HTTP_X_FORWARDED_PROTO']);
    ob_start(); cafe_run_site($httpPrivate); $publicPage=ob_get_clean();
    check(http_response_code() === 200 && str_contains($publicPage, '&lt;кофе&gt;'), 'Public page works before MFA/config provisioning');
    $passed[] = 'HTTPS authentication gate ignores forwarded headers; public page survives missing admin setup';

    $htaccess = file_get_contents(dirname(__DIR__).'/public/.htaccess');
    check(preg_match('/^RewriteRule (\(\^\|\/\)\\\.) - \[F,L\]\r?$/m', $htaccess, $deny) === 1, 'Dot-directory denial exists');
    foreach (['.git/config','sub/.data/auth.json','x/.env/secret'] as $path) check(preg_match('~'.$deny[1].'~', $path) === 1, 'Dot-folder rule blocks '.$path);
    check(strpos($htaccess, 'acme-challenge') < strpos($htaccess, $deny[0]), 'Certificate exception precedes dot denial');
    check(!preg_match('/RewriteRule .*https:/', $htaccess), 'Hosting-panel redirects are not duplicated');
    $passed[] = 'Apache dot-folder denial and panel-managed redirect rules';
} finally { putenv('CAFE_ENV'); removeFixture($root, $base); }

foreach ($passed as $name) echo 'PASS '.$name.PHP_EOL;
echo 'PHP menu/site tests: '.count($passed).' passed'.PHP_EOL;

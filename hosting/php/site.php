<?php
declare(strict_types=1);

require_once __DIR__.'/menu.php';
require_once __DIR__.'/orders.php';

const CAFE_SITE_URL = 'https://vosem-utra.ru/';
const CAFE_SEO_TITLE = 'Восемь утра — кофе и завтраки весь день на Шелепихинской набережной';
const CAFE_SEO_DESCRIPTION = 'Кофейня «Восемь утра» в ЖК «Сердце Столицы», Москва, Шелепихинская набережная, 34, корп. 6. Завтраки весь день, кофе и десерты. Ежедневно с 8:00 до 20:00.';
const CAFE_CATEGORIES = ['signature'=>'Фирменные завтраки', 'eggs'=>'Яйца и тосты', 'porridge'=>'Каши и гранола', 'sweet'=>'Сладкое утро'];

function cafe_html(mixed $value): string { return htmlspecialchars((string)($value ?? ''), ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8'); }
function cafe_money(int|float $price): string {
    $decimals = abs($price - round($price)) < 0.000001 ? 0 : 2;
    $value = number_format($price, $decimals, ',', "\u{00a0}");
    if ($decimals) $value = rtrim($value, '0');
    return $value."\u{00a0}₽";
}
function cafe_published(array $items): array {
    $published = array_values(array_filter($items, static fn(array $item): bool => $item['published'] === true));
    usort($published, static fn(array $a, array $b): int => $a['order'] <=> $b['order']);
    return $published;
}
function cafe_dish_html(array $item): string {
    $name = cafe_html($item['name']);
    $visual = $item['image'] !== '' ? '<div class="dish-visual"><img class="dish-photo" src="'.cafe_html($item['image']).'" width="600" height="450" alt="'.$name.'" loading="lazy" decoding="async">'.($item['category'] === 'signature' ? '<span class="dish-badge">Фирменный завтрак</span>' : '').'</div>' : '';
    $available = ($item['availableForOrder'] ?? true) !== false;
    $label = $available ? 'В корзину' : 'Временно недоступно';
    $action = '<button class="dish-order-button'.($available ? '' : ' is-unavailable').'" type="button" data-cart-add="'.cafe_html($item['id']).'" aria-label="'.$label.': '.$name.'"'.($available ? '' : ' disabled').'>'.$label.'</button>';
    return '<article class="dish-card'.($visual === '' ? ' dish-card-text' : '').'" data-reveal="visual" data-reveal-key="dish:'.cafe_html($item['id']).'">'.$visual.'<div class="dish-body"><p class="dish-category">'.cafe_html(CAFE_CATEGORIES[$item['category']]).'</p><div class="dish-heading"><h3>'.$name.'</h3><span class="dish-price">'.cafe_money($item['price']).'</span></div><p class="dish-description">'.cafe_html($item['description']).'</p><div class="dish-cart-actions" data-cart-item="'.cafe_html($item['id']).'">'.$action.'</div></div></article>';
}
function cafe_schema(array $items): array {
    $published = cafe_published($items); $sections = [];
    foreach (CAFE_CATEGORIES as $category => $name) {
        $dishes = [];
        foreach ($published as $item) {
            if ($item['category'] !== $category) continue;
            $dish = ['@type'=>'MenuItem', 'name'=>$item['name'], 'description'=>$item['description'], 'offers'=>['@type'=>'Offer', 'price'=>$item['price'], 'priceCurrency'=>'RUB']];
            if ($item['image'] !== '') $dish['image'] = CAFE_SITE_URL.ltrim($item['image'], '/');
            $dishes[] = $dish;
        }
        if ($dishes) $sections[] = ['@type'=>'MenuSection', 'name'=>$name, 'hasMenuItem'=>$dishes];
    }
    return [
        '@context'=>'https://schema.org', '@type'=>'CafeOrCoffeeShop', '@id'=>CAFE_SITE_URL.'#cafe', 'name'=>'Восемь утра', 'url'=>CAFE_SITE_URL,
        'description'=>CAFE_SEO_DESCRIPTION, 'image'=>CAFE_SITE_URL.'social-cover.webp', 'telephone'=>'+79851308106',
        'address'=>['@type'=>'PostalAddress', 'streetAddress'=>'Шелепихинская набережная, 34, корпус 6', 'addressLocality'=>'Москва', 'addressCountry'=>'RU'],
        'openingHoursSpecification'=>[['@type'=>'OpeningHoursSpecification', 'dayOfWeek'=>['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], 'opens'=>'08:00', 'closes'=>'20:00']],
        'menu'=>CAFE_SITE_URL.'#menu', 'hasMenu'=>['@type'=>'Menu', '@id'=>CAFE_SITE_URL.'#breakfast-menu', 'name'=>'Завтраки', 'url'=>CAFE_SITE_URL.'#menu', 'hasMenuSection'=>$sections],
        'sameAs'=>['https://yandex.ru/maps/org/vosem_utra/133294557510/', 'https://t.me/vosemutracafe'],
    ];
}
function cafe_menu_slot(string $html, string $name, string $content): string {
    $start = '<!-- SEO:'.strtoupper($name).':START -->'; $end = '<!-- SEO:'.strtoupper($name).':END -->';
    $replacement = $start."\n".$content."\n".$end;
    $managed = '~'.preg_quote($start, '~').'.*?'.preg_quote($end, '~').'~s';
    if (preg_match($managed, $html)) return preg_replace_callback($managed, static fn(): string => $replacement, $html, 1);
    $empty = '~(<div\b[^>]*\bdata-'.preg_quote($name, '~').'(?:="[^"]*")?[^>]*>)\s*(</div>)~i';
    if (!preg_match($empty, $html)) throw new RuntimeException('Missing menu template slot');
    return preg_replace_callback($empty, static fn(array $match): string => $match[1].$replacement.$match[2], $html, 1);
}
function cafe_toggle_hidden(string $html, string $attribute, bool $hidden): string {
    return preg_replace_callback('~<[^>]+\b'.preg_quote($attribute, '~').'(?:="[^"]*")?[^>]*>~i', static function (array $match) use ($hidden): string {
        $tag = preg_replace('~\s+hidden(?:\s*=\s*(?:"[^"]*"|\x27[^\x27]*\x27|[^\s>]+))?~i', '', $match[0]);
        return $hidden ? substr($tag, 0, -1).' hidden>' : $tag;
    }, $html, 1);
}
function cafe_transform_page(string $html, string $page, bool $production, array $items = [], array $config = []): string {
    $home = $page === 'index';
    $directive = $home && $production ? 'index, follow, max-image-preview:large' : ($production && in_array($page, ['privacy','consent'], true) ? 'noindex, follow' : 'noindex, nofollow');
    preg_match('~<title\b[^>]*>(.*?)</title>~is', $html, $oldTitle);
    preg_match('~<meta\b[^>]*\bname=["\x27]description["\x27][^>]*\bcontent=["\x27]([^"\x27]*)["\x27][^>]*>~i', $html, $oldDescription);
    $title = $home ? CAFE_SEO_TITLE : html_entity_decode($oldTitle[1] ?? 'Восемь утра', ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $tags = ['<title>'.cafe_html($title).'</title>', '<meta name="robots" content="'.$directive.'">'];
    if ($home || isset($oldDescription[1])) $tags[] = '<meta name="description" content="'.cafe_html($home ? CAFE_SEO_DESCRIPTION : html_entity_decode($oldDescription[1], ENT_QUOTES | ENT_HTML5, 'UTF-8')).'">';
    if ($home && $production) {
        $tags[] = '<link rel="canonical" href="'.CAFE_SITE_URL.'">';
        $meta = ['og:type'=>'website','og:locale'=>'ru_RU','og:site_name'=>'Восемь утра','og:title'=>CAFE_SEO_TITLE,'og:description'=>CAFE_SEO_DESCRIPTION,'og:url'=>CAFE_SITE_URL,'og:image'=>CAFE_SITE_URL.'social-cover.webp','og:image:width'=>'1254','og:image:height'=>'1254','og:image:alt'=>'Две чашки кофе в кофейне «Восемь утра»','twitter:card'=>'summary_large_image','twitter:title'=>CAFE_SEO_TITLE,'twitter:description'=>CAFE_SEO_DESCRIPTION,'twitter:image'=>CAFE_SITE_URL.'social-cover.webp','twitter:image:alt'=>'Две чашки кофе в кофейне «Восемь утра»'];
        foreach ($meta as $key => $value) $tags[] = '<meta '.(str_starts_with($key, 'og:') ? 'property' : 'name').'="'.$key.'" content="'.cafe_html($value).'">';
        foreach (['google_verification'=>'google-site-verification','yandex_verification'=>'yandex-verification'] as $key => $name) {
            if (is_string($config[$key] ?? null) && trim($config[$key]) !== '') $tags[] = '<meta name="'.$name.'" content="'.cafe_html(trim($config[$key])).'">';
        }
        $json = json_encode(cafe_schema($items), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR);
        $tags[] = '<script type="application/ld+json" id="cafe-structured-data">'.$json.'</script>';
    }
    $html = preg_replace('~\s*<!-- SEO:HEAD:START -->.*?<!-- SEO:HEAD:END -->\s*~s', "\n", $html);
    $html = preg_replace_callback('~<meta\b[^>]*>~i', static function (array $match): string {
        if (!preg_match('~\b(?:name|property)\s*=\s*["\x27]([^"\x27]+)["\x27]~i', $match[0], $attribute)) return $match[0];
        $name = strtolower($attribute[1]);
        return in_array($name, ['robots','googlebot','yandex','description','google-site-verification','yandex-verification'], true) || str_starts_with($name, 'og:') || str_starts_with($name, 'twitter:') ? '' : $match[0];
    }, $html);
    $html = preg_replace('~<link\b[^>]*\brel\s*=\s*["\x27]canonical["\x27][^>]*>|<title\b[^>]*>.*?</title>~is', '', $html);
    if (!preg_match('~</head>~i', $html)) throw new RuntimeException('Missing page head');
    $html = preg_replace_callback('~</head>~i', static fn(): string => "<!-- SEO:HEAD:START -->\n".implode("\n", $tags)."\n<!-- SEO:HEAD:END -->\n</head>", $html, 1);
    if ($home) {
        $published = cafe_published($items); $grid = []; $extras = [];
        foreach ($published as $item) { if ($item['image'] !== '') $grid[] = cafe_dish_html($item); else $extras[] = cafe_dish_html($item); }
        $html = cafe_menu_slot($html, 'dish-grid', implode("\n", $grid));
        $html = cafe_menu_slot($html, 'dish-extras', implode("\n", $extras));
        $html = cafe_toggle_hidden($html, 'data-extra-section', !$extras);
        $html = cafe_toggle_hidden($html, 'data-menu-empty', (bool)$published);
        $count = count($published);
        $word = $count % 10 === 1 && $count % 100 !== 11 ? 'блюдо' : ($count % 10 >= 2 && $count % 10 <= 4 && ($count % 100 < 12 || $count % 100 > 14) ? 'блюда' : 'блюд');
        $html = preg_replace_callback('~<span\b([^>]*\bdata-menu-count[^>]*)>.*?</span>~is', static fn(array $match): string => '<span'.$match[1].'>'.$count.' '.$word.'</span>', $html, 1);
        $html = preg_replace('~<noscript>\s*<p>Чтобы увидеть карточки блюд,.*?</p>\s*</noscript>~s', '<noscript><p>Меню доступно выше. Для выбора категории включите JavaScript.</p></noscript>', $html);
    }
    return $html;
}
function cafe_security_headers(bool $production): void {
    header('X-Content-Type-Options: nosniff'); header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin'); header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()');
    header('Cross-Origin-Resource-Policy: same-origin');
    if ($production) header('Strict-Transport-Security: max-age=31536000');
}
function cafe_secure_html(string $html, string $page): string {
    $nonce = base64_encode(random_bytes(24));
    $captcha = $page === 'registration';
    $policy = ["default-src 'self'", "script-src 'self' 'nonce-".$nonce."'".($captcha ? ' https://www.recaptcha.net https://www.gstatic.com' : ''),
        "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self'".($captcha ? ' https://www.recaptcha.net' : ''),
        $captcha ? 'frame-src https://www.recaptcha.net https://recaptcha.google.com' : "frame-src 'none'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'"];
    header('Content-Security-Policy: '.implode('; ', $policy));
    return preg_replace_callback('~<script\b([^>]*)>~i', static function (array $match) use ($nonce): string {
        $attributes = preg_replace('~\s+nonce\s*=\s*(?:"[^"]*"|\x27[^\x27]*\x27|[^\s>]+)~i', '', $match[1]);
        return '<script'.$attributes.' nonce="'.$nonce.'">';
    }, $html);
}
function cafe_site_config(string $privateDir): array {
    $path = $privateDir.'/admin-config.php';
    $config = is_file($path) ? require $path : [];
    if (!is_array($config)) throw new RuntimeException('Invalid site configuration');
    foreach (['publicOrigin'=>'public_origin','username'=>'bootstrap_username','passwordHash'=>'bootstrap_password_hash','encryptionKey'=>'encryption_key','googleVerification'=>'google_verification','yandexVerification'=>'yandex_verification'] as $source => $target) {
        if (array_key_exists($source, $config) && !array_key_exists($target, $config)) $config[$target] = $config[$source];
    }
    $config['public_origin'] ??= 'https://vosem-utra.ru';
    $config['allow_http_dev'] = false;
    $config['production'] = true;
    if (getenv('CAFE_ENV') === 'development') {
        $host = $_SERVER['HTTP_HOST'] ?? '';
        if (!in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1','::1'], true) || !preg_match('/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/D', $host)) throw new RuntimeException('Development requires loopback');
        $config['public_origin'] = 'http://'.$host;
        $config['allow_http_dev'] = true; $config['production'] = false;
    } else {
        $origin = is_string($config['public_origin']) ? parse_url($config['public_origin']) : false;
        if (!$origin || ($origin['scheme'] ?? '') !== 'https' || empty($origin['host']) || isset($origin['user'], $origin['pass']) || isset($origin['user']) || isset($origin['path']) || isset($origin['query']) || isset($origin['fragment']) || !preg_match('~^https://[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$~D', $config['public_origin'])) throw new RuntimeException('Invalid production origin');
    }
    // Test origins can never advertise themselves as the canonical production website.
    $config['indexing'] = $config['production'] && $config['public_origin'] === rtrim(CAFE_SITE_URL, '/') && ($config['indexing'] ?? true) === true;
    return $config;
}
function cafe_respond(int $status, string $type, string $body, string $cache = 'no-store'): void {
    http_response_code($status); header('Content-Type: '.$type); header('Cache-Control: '.$cache); header('Content-Length: '.strlen($body));
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') echo $body;
}
function cafe_run_site(string $privateDir): void {
    ini_set('display_errors', '0');
    try {
        $config = cafe_site_config($privateDir); $production = $config['production']; $indexing = $config['indexing'];
        cafe_security_headers($production);
        $rawPath = explode('?', $_SERVER['REQUEST_URI'] ?? '/')[0];
        if (preg_match('/%(?![a-fA-F0-9]{2})/', $rawPath)) throw new CafeMenuException(400, 'Некорректный адрес.', 'invalid_url');
        $path = rawurldecode($rawPath); $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        $forbidden = preg_match('~(?:^|/)(?:\.|vosem-utra-private(?:/|$)|admin-data(?:/|$)|orders?-data(?:/|$)|server(?:/|$)|node_modules(?:/|$)|hosting-tools(?:/|$)|site-build\.json(?:/|$))~i', $path);
        if ($forbidden || str_contains($path, '\\') || preg_match('/[\x00-\x1f\x7f]/', $path)) throw new CafeMenuException(404, 'Страница не найдена.', 'not_found');
        if (!$indexing) header('X-Robots-Tag: noindex, nofollow');
        $menu = new CafeMenu($privateDir, $config);
        if (preg_match('~^/api/(?:ordering|orders(?:/.*)?)$~D', $path)) {
            $orders = new CafeOrders($privateDir, $config, static fn(): array => $menu->catalog());
            if ($orders->dispatch($path, $method)) return;
        }
        if ($menu->dispatch($path, $method)) return;
        if (!in_array($method, ['GET','HEAD'], true)) { header('Allow: GET, HEAD'); throw new CafeMenuException(405, 'Метод не поддерживается.', 'method'); }
        if (in_array($path, ['/index.html','/admin','/admin/'], true)) {
            $query = isset($_SERVER['QUERY_STRING']) && $_SERVER['QUERY_STRING'] !== '' ? '?'.$_SERVER['QUERY_STRING'] : '';
            header('Location: '.($path === '/index.html' ? '/' : '/admin.html').$query, true, 308); header('Cache-Control: no-cache'); return;
        }
        if ($path === '/robots.txt') {
            cafe_respond(200, 'text/plain; charset=utf-8', "# ".($indexing ? 'Production' : 'Preview: page-level noindex')."\nUser-agent: *\nDisallow: /api/\n".($indexing ? "\nSitemap: ".CAFE_SITE_URL."sitemap.xml\n" : ''), 'no-cache'); return;
        }
        if ($path === '/sitemap.xml') {
            cafe_respond(200, 'application/xml; charset=utf-8', '<?xml version="1.0" encoding="UTF-8"?>'."\n".'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'.($indexing ? "\n  <url><loc>".CAFE_SITE_URL."</loc></url>\n" : '')."</urlset>\n", 'no-cache'); return;
        }
        $pages = ['/'=>'index','/admin.html'=>'admin','/registration.html'=>'registration','/privacy.html'=>'privacy','/consent.html'=>'consent','/checkout.html'=>'checkout','/order-terms.html'=>'order-terms'];
        if (!isset($pages[$path])) throw new CafeMenuException(404, 'Страница не найдена.', 'not_found');
        $page = $pages[$path];
        $html = @file_get_contents($privateDir.'/app/templates/'.$page.'.html');
        if ($html === false) throw new RuntimeException('Page template unavailable');
        $html = cafe_transform_page($html, $page, $indexing, $page === 'index' ? $menu->read()['items'] : [], $config);
        if (!$indexing || $page !== 'index') header('X-Robots-Tag: '.($indexing && in_array($page, ['privacy','consent'], true) ? 'noindex, follow' : 'noindex, nofollow'));
        cafe_respond(200, 'text/html; charset=utf-8', cafe_secure_html($html, $page));
    } catch (CafeMenuException $error) {
        header('X-Robots-Tag: noindex, nofollow'); cafe_respond($error->status, 'text/plain; charset=utf-8', $error->getMessage());
    } catch (Throwable) {
        // Do not reflect filenames, configuration values or supplied credentials.
        error_log('Cafe page request failed.'); header('X-Robots-Tag: noindex, nofollow');
        cafe_respond(503, 'text/plain; charset=utf-8', 'Сайт временно недоступен. Пожалуйста, повторите позже.');
    }
}

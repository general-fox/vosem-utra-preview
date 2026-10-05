<?php
declare(strict_types=1);
require_once __DIR__.'/../hosting/php/kds-client.php';
$passed = 0;
function kdsCheck(bool $condition, string $message = 'Assertion failed'): void { if (!$condition) throw new RuntimeException($message); }
function kdsError(callable $fn, string $code): CafeKdsException {
    try { $fn(); } catch (CafeKdsException $error) { kdsCheck($error->errorCode === $code, 'Unexpected KDS error'); return $error; }
    throw new RuntimeException('Expected KDS failure');
}
function kdsTest(string $name, callable $fn): void { global $passed; $fn(); $passed++; echo "PASS: $name\n"; }
function kdsConfig(): array { return ['baseUrl'=>'https://kds.example/api/v1', 'serviceName'=>'fixture-service', 'servicePassword'=>'fictional-password']; }
function kdsFixture(array $responses): array {
    $calls = (object)['items'=>[], 'responses'=>$responses];
    $client = new CafeKdsClient(kdsConfig(), static function (string $url, string $method, array $headers, ?string $body) use ($calls): array {
        $calls->items[] = compact('url', 'method', 'headers', 'body');
        $next = array_shift($calls->responses);
        if ($next === null) throw new RuntimeException('Unexpected extra request');
        return $next;
    });
    return [$client, $calls];
}
function kdsResponse(mixed $body, int $status = 200): array { return ['status'=>$status, 'body'=>json_encode($body, JSON_THROW_ON_ERROR)]; }
function kdsToken(string $value = 'fictional.token.value'): array { return kdsResponse(['accessToken'=>$value]); }

kdsTest('rejects unapproved HTTP, embedded credentials and malformed API origins before any network call', function (): void {
    foreach (['http://89.108.109.59:5262/api/v1', 'https://login:password@kds.example/api/v1', 'https://kds.example/api/v1?key=secret', 'https://kds.example/api/v1#fragment', "https://kds.example/api/v1\r\n", 'file:///api/v1', 'https://kds.example/other', 'https://kds.example/../api/v1'] as $base) {
        kdsError(static fn() => new CafeKdsClient(array_replace(kdsConfig(), ['baseUrl'=>$base])), 'invalid_configuration');
    }
    foreach (['serviceName', 'servicePassword'] as $field) kdsError(static fn() => new CafeKdsClient(array_replace(kdsConfig(), [$field=>''])), 'invalid_configuration');
});
kdsTest('LAN endpoint is selected only by explicit local server configuration', function (): void {
    $config = kdsConfig()+['environment'=>'staging', 'localBaseUrl'=>'https://lan.example/api/v1'];
    foreach ([[], ['staging'=>true, 'indexing'=>false], ['allow_http_dev'=>false], ['allow_http_dev'=>'true']] as $site) {
        $resolved = CafeKdsClient::configForSite($config, $site);
        kdsCheck($resolved['baseUrl'] === $config['baseUrl'] && !isset($resolved['localBaseUrl']));
    }
    $resolved = CafeKdsClient::configForSite($config, ['allow_http_dev'=>true]);
    kdsCheck($resolved['baseUrl'] === $config['localBaseUrl'] && $resolved['servicePassword'] === $config['servicePassword']);
    $calls = [];
    $client = new CafeKdsClient($resolved, static function ($url, $method) use (&$calls): array {
        $calls[] = $url; return $method === 'POST' ? kdsToken() : kdsResponse([]);
    });
    $client->organizations();
    kdsCheck($calls === ['https://lan.example/api/v1/clients/service-token', 'https://lan.example/api/v1/external/get-organizations']);
    kdsCheck(CafeKdsClient::configForSite(kdsConfig(), ['allow_http_dev'=>true]) === kdsConfig());
    kdsCheck(CafeKdsClient::configForSite(array_replace($config, ['localBaseUrl'=>'']), ['allow_http_dev'=>true])['baseUrl'] === $config['baseUrl']);
    kdsError(fn() => CafeKdsClient::configForSite(array_replace($config, ['environment'=>'production']), ['allow_http_dev'=>true]), 'invalid_configuration');
    kdsError(fn() => CafeKdsClient::configForSite(array_replace($config, ['localBaseUrl'=>[]]), ['allow_http_dev'=>true]), 'invalid_configuration');
});
kdsTest('HTTP exception restricts organization-specific calls while allowing read-only discovery', function (): void {
    $id = 'baa06e7a-b091-4296-97bc-275bc22d9af9';
    $config = array_replace(kdsConfig(), ['baseUrl'=>'http://89.108.109.59:5262/api/v1', 'environment'=>'staging', 'allowHttpForTest'=>true, 'organizationId'=>$id]);
    foreach ([['environment'=>'production'], ['allowHttpForTest'=>false], ['organizationId'=>'00000000-0000-4000-8000-000000000001'], ['baseUrl'=>'http://kds.example/api/v1']] as $override) {
        kdsError(fn() => new CafeKdsClient(array_replace($config, $override)), 'invalid_configuration');
    }
    $calls = [];
    $client = new CafeKdsClient($config, static function ($url, $method) use (&$calls, $id): array {
        $calls[] = [$url, $method];
        return $method === 'POST' ? kdsToken() : kdsResponse([['id'=>$id]]);
    });
    kdsCheck($client->organizations() === [['id'=>$id]] && count($calls) === 2);
    kdsError(fn() => $client->menu('00000000-0000-4000-8000-000000000001'), 'test_organization_only');
    kdsCheck(count($calls) === 2);
    $client = new CafeKdsClient($config, static fn($url, $method): array => $method === 'POST' ? kdsToken() : kdsResponse([['id'=>$id], ['id'=>'00000000-0000-4000-8000-000000000001']]));
    kdsCheck(count($client->organizations()) === 2);
    kdsError(fn() => $client->menu('00000000-0000-4000-8000-000000000001'), 'test_organization_only');
});
kdsTest('exchanges service credentials once, uses Bearer only for external reads and explicit isDelivery flag', function (): void {
    $id = '49184a17-69b6-4be6-af7e-b7fa86d0e080';
    [$client, $calls] = kdsFixture([kdsToken(), kdsResponse([['id'=>$id]]), kdsResponse(['groups'=>[], 'periods'=>[]]), kdsResponse([]), kdsResponse([]), kdsResponse(['forbidden'=>[], 'limited'=>[]])]);
    kdsCheck($client->organizations()[0]['id'] === $id);
    $client->menu($id, false); $client->currencies($id); $client->periods($id); $client->rests($id);
    kdsCheck(count($calls->items) === 6);
    $auth = $calls->items[0]; kdsCheck($auth['url'] === 'https://kds.example/api/v1/clients/service-token' && $auth['method'] === 'POST');
    kdsCheck(json_decode($auth['body'], true) === ['name'=>'fixture-service', 'password'=>'fictional-password']);
    kdsCheck(!in_array('Authorization: Bearer fictional.token.value', $auth['headers'], true));
    foreach (array_slice($calls->items, 1) as $request) {
        kdsCheck($request['method'] === 'GET' && $request['body'] === null);
        kdsCheck(in_array('Authorization: Bearer fictional.token.value', $request['headers'], true));
    }
    kdsCheck(str_ends_with($calls->items[2]['url'], 'organizationId='.$id.'&isDelivery=false'));
    kdsCheck(!str_contains(json_encode($calls->items), 'create-order') && !str_contains(json_encode($calls->items), 'pay-order'));
});
kdsTest('replacement HTTP endpoints stay pinned to the verified demo organization', function (): void {
    $id = 'd840d3ea-e6b7-4097-9db3-8acd45259bf2';
    $old = 'baa06e7a-b091-4296-97bc-275bc22d9af9';
    foreach (['http://192.168.2.117:8081/api/v1', 'http://146.158.119.207:8081/api/v1'] as $base) {
        $config = array_replace(kdsConfig(), ['baseUrl'=>$base, 'environment'=>'staging', 'allowHttpForTest'=>true, 'organizationId'=>$id]);
        $calls = [];
        $client = new CafeKdsClient($config, static function ($url, $method) use (&$calls): array {
            $calls[] = $url;
            return $method === 'POST' ? kdsToken() : kdsResponse(['forbidden'=>[], 'limited'=>[]]);
        });
        kdsError(fn() => $client->rests($old), 'test_organization_only');
        kdsError(fn() => $client->createPending(['organizationId'=>$id, 'items'=>[['name'=>'test']]]), 'test_orders_only');
        kdsCheck($calls === []);
        $client->rests($id);
        kdsCheck($calls === [$base.'/clients/service-token', $base.'/external/get-dish-rests?organizationId='.$id]);
        foreach ([['organizationId'=>$old], ['environment'=>'production'], ['allowHttpForTest'=>false], ['baseUrl'=>str_replace(':8081', ':8082', $base)]] as $override) {
            kdsError(fn() => new CafeKdsClient(array_replace($config, $override)), 'invalid_configuration');
        }
        $client = new CafeKdsClient(array_replace($config, ['enableTestOrders'=>true]), static function ($url) use (&$calls): array {
            $calls[]=$url; return str_ends_with($url, 'service-token') ? kdsToken() : kdsResponse(['pendingOrderId'=>'fixture-pending']);
        });
        kdsError(fn() => $client->createPending(['organizationId'=>$old, 'items'=>[['name'=>'test']]]), 'test_orders_only');
        kdsCheck($client->createPending(['organizationId'=>$id, 'items'=>[['name'=>'test']]])['pendingOrderId'] === 'fixture-pending');
        kdsCheck(end($calls) === $base.'/external/create-order');
    }
});
kdsTest('renews an expired token only once for a read and does not loop on invalid credentials', function (): void {
    [$client, $calls] = kdsFixture([kdsToken('old'), kdsResponse([], 401), kdsToken('new'), kdsResponse([])]);
    kdsCheck($client->organizations() === [] && count($calls->items) === 4);
    kdsCheck(in_array('Authorization: Bearer new', $calls->items[3]['headers'], true));
    [$client, $calls] = kdsFixture([kdsToken(), kdsResponse([], 401), kdsToken(), kdsResponse([], 401)]);
    kdsError(fn() => $client->organizations(), 'unauthorized'); kdsCheck(count($calls->items) === 4);
    [$client, $calls] = kdsFixture([kdsResponse([], 401)]);
    kdsError(fn() => $client->organizations(), 'unauthorized'); kdsCheck(count($calls->items) === 1);
});
kdsTest('does not follow redirects or retry forbidden, rate-limited or failed reads; provider errors are redacted', function (): void {
    foreach ([302=>'redirect_refused', 403=>'organization_forbidden', 429=>'rate_limited', 500=>'upstream_unavailable'] as $status=>$code) {
        [$client, $calls] = kdsFixture([kdsToken(), ['status'=>$status, 'body'=>'fictional-password, token, guest phone and provider debug data']]);
        $error = kdsError(fn() => $client->organizations(), $code);
        kdsCheck($error->httpStatus === $status && !str_contains($error->getMessage(), 'fictional-password'));
        kdsCheck(count($calls->items) === 2);
    }
});
kdsTest('rejects header injection tokens, invalid JSON, invalid schemas and oversized responses', function (): void {
    [$client] = kdsFixture([kdsToken("value\r\nX-Forged: yes")]); kdsError(fn() => $client->organizations(), 'invalid_token');
    foreach ([['status'=>200,'body'=>'<html>login</html>'], kdsResponse(true), kdsResponse(['error'=>'oops']), ['status'=>200,'body'=>str_repeat('x', 33554433)]] as $response) {
        [$client] = kdsFixture([kdsToken(), $response]);
        kdsError(fn() => $client->organizations(), strlen($response['body']) > 33554432 ? 'response_too_large' : 'invalid_response');
    }
    [$client] = kdsFixture([kdsToken(), kdsResponse([])]);
    kdsError(fn() => $client->menu('49184a17-69b6-4be6-af7e-b7fa86d0e080'), 'invalid_response');
});
kdsTest('reads Pending by pendingOrderId and an accepted POS order by its external GUID without creating another order', function (): void {
    $organization = '49184a17-69b6-4be6-af7e-b7fa86d0e080'; $guid = '00000000-0000-4000-8000-000000000123';
    [$client, $calls] = kdsFixture([kdsToken(), kdsResponse(['pendingOrderId'=>'123','pendingStatus'=>'Pending']), kdsResponse(['externalGuid'=>$guid,'kitchenStatus'=>'Ready'])]);
    kdsCheck($client->pendingOrder($organization, '123')['pendingStatus'] === 'Pending');
    kdsCheck($client->order($organization, $guid)['kitchenStatus'] === 'Ready');
    kdsCheck($calls->items[1]['url'] === 'https://kds.example/api/v1/external/get-pending-order?organizationId='.$organization.'&pendingOrderId=123');
    kdsCheck($calls->items[2]['url'] === 'https://kds.example/api/v1/external/get-order?organizationId='.$organization.'&orderGuid='.$guid);
    kdsCheck($calls->items[1]['method'] === 'GET' && $calls->items[2]['method'] === 'GET');
    kdsError(fn() => $client->pendingOrder($organization, '123&order=999'), 'invalid_order_identifier');
    kdsCheck(count($calls->items) === 3);
});
kdsTest('validates organization before authentication and does not serialize or debug-print credentials', function (): void {
    [$client, $calls] = kdsFixture([]);
    kdsError(fn() => $client->menu('other&organizationId=secret'), 'invalid_organization'); kdsCheck($calls->items === []);
    ob_start(); var_dump($client); $debug = ob_get_clean();
    kdsCheck(!str_contains($debug, 'fictional-password') && !str_contains($debug, 'fixture-service'));
    kdsError(fn() => serialize($client), 'credentials_not_serializable');
    $client = new CafeKdsClient(kdsConfig(), static function (): array { throw new RuntimeException('fictional-password'); });
    $error = kdsError(fn() => $client->organizations(), 'connection_failed');
    kdsCheck($error->getPrevious() === null && !str_contains($error->getMessage(), 'fictional-password'));
});
kdsTest('create is single-attempt even on 401, transport failure and malformed response', function (): void {
    $id='baa06e7a-b091-4296-97bc-275bc22d9af9';
    $config=kdsConfig()+['environment'=>'staging','organizationId'=>$id,'enableTestOrders'=>true];
    foreach(['unauthorized','lost','invalid'] as $failure) {
        $calls=[];
        $client=new CafeKdsClient($config,static function($url,$method)use(&$calls,$failure):array {
            $calls[]=$url;
            if(str_ends_with($url,'service-token')) return kdsToken();
            if($failure==='lost') throw new RuntimeException('lost');
            return ['status'=>$failure==='unauthorized'?401:200,'body'=>$failure==='invalid'?'invalid':'{}'];
        });
        kdsError(fn()=>$client->createPending(['organizationId'=>$id,'items'=>[['name'=>'test']]]),match($failure){'unauthorized'=>'unauthorized','lost'=>'connection_failed',default=>'invalid_response'});
        kdsCheck(count($calls)===2);
    }
    [$client,$calls]=kdsFixture([]);
    kdsError(fn()=>$client->createPending(['organizationId'=>$id,'items'=>[]]),'test_orders_only'); kdsCheck($calls->items===[]);
});
echo "$passed KDS connectivity tests passed. No external requests made.\n";

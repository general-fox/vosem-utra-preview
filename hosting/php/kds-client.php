<?php
declare(strict_types=1);

/** StarsRkConnect: reference reads, status reads and explicitly enabled test Pending orders. */
final class CafeKdsException extends RuntimeException
{
    public function __construct(public string $errorCode, public int $httpStatus = 0)
    {
        // Provider response bodies and credentials must not enter logs or error pages.
        parent::__construct('KDS request failed: '.$errorCode);
    }
}

final class CafeKdsClient
{
    private string $baseUrl;
    private string $name;
    private string $password;
    private ?string $token = null;
    private bool $httpTest;
    private bool $testOrders;
    private string $testOrganization;
    private Closure $transport;
    private const MAX_RESPONSE = 33554432;
    private const HTTP_TEST_PROFILES = [
        'http://89.108.109.59:5262/api/v1' => 'baa06e7a-b091-4296-97bc-275bc22d9af9',
        'http://146.158.119.207:8081/api/v1' => 'd840d3ea-e6b7-4097-9db3-8acd45259bf2',
        'http://192.168.2.117:8081/api/v1' => 'd840d3ea-e6b7-4097-9db3-8acd45259bf2',
    ];
    private const READ_METHODS = ['get-organizations', 'get-menu', 'get-currencies', 'get-periods', 'get-dish-rests', 'get-pending-order', 'get-order'];

    /** Only the server's development configuration may select the LAN endpoint. */
    public static function configForSite(array $config, array $site): array
    {
        if (($site['allow_http_dev'] ?? false) === true && ($config['localBaseUrl'] ?? '') !== '') {
            if (($config['environment'] ?? '') !== 'staging' || !is_string($config['localBaseUrl'])) {
                throw new CafeKdsException('invalid_configuration');
            }
            $config['baseUrl'] = $config['localBaseUrl'];
        }
        unset($config['localBaseUrl']);
        return $config;
    }

    public static function testOrdersAllowed(array $config): bool
    {
        return ($config['enableTestOrders'] ?? false) === true && ($config['environment'] ?? '') === 'staging'
            && in_array($config['organizationId'] ?? '', self::HTTP_TEST_PROFILES, true);
    }

    public function __construct(array $config, ?callable $transport = null)
    {
        $base = $config['baseUrl'] ?? null;
        if (!is_string($base) || strlen($base) > 2048 || preg_match('/[\x00-\x20\x7f\\\\]/', $base)) throw new CafeKdsException('invalid_configuration');
        $url = parse_url($base);
        $approvedOrganization = self::HTTP_TEST_PROFILES[rtrim($base, '/')] ?? null;
        $this->httpTest = ($config['allowHttpForTest'] ?? false) === true && ($config['environment'] ?? '') === 'staging'
            && $approvedOrganization !== null
            && is_string($config['organizationId'] ?? null) && strcasecmp($config['organizationId'], $approvedOrganization) === 0;
        if (!is_array($url) || (($url['scheme'] ?? '') !== 'https' && !$this->httpTest) || empty($url['host'])
            || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment'])
            || !preg_match('~^/(?:[a-zA-Z0-9_-]+/)*api/v1/?$~D', $url['path'] ?? '')) throw new CafeKdsException('invalid_configuration');
        foreach (['serviceName'=>256, 'servicePassword'=>4096] as $field=>$limit) {
            if (!is_string($config[$field] ?? null) || trim($config[$field]) === '' || strlen($config[$field]) > $limit) throw new CafeKdsException('invalid_configuration');
        }
        $this->baseUrl = rtrim($base, '/');
        $this->testOrders = self::testOrdersAllowed($config);
        $this->testOrganization = is_string($config['organizationId'] ?? null) ? strtolower($config['organizationId']) : '';
        $this->name = $config['serviceName']; $this->password = $config['servicePassword'];
        $allowHttp = $this->httpTest;
        $this->transport = $transport === null ? static fn(string $url, string $method, array $headers, ?string $body): array => self::http($url, $method, $headers, $body, $allowHttp) : Closure::fromCallable($transport);
    }

    public function __debugInfo(): array { return ['configured'=>true]; }
    public function __serialize(): array { throw new CafeKdsException('credentials_not_serializable'); }

    private static function http(string $url, string $method, array $headers, ?string $body, bool $allowHttp): array
    {
        if (!function_exists('curl_init')) throw new CafeKdsException('curl_required');
        $handle = curl_init($url);
        if ($handle === false) throw new CafeKdsException('transport_unavailable');
        $response = ''; $tooLarge = false;
        try {
            curl_setopt_array($handle, [
                CURLOPT_CUSTOMREQUEST=>$method, CURLOPT_HTTPHEADER=>$headers,
                CURLOPT_FOLLOWLOCATION=>false, CURLOPT_MAXREDIRS=>0,
                CURLOPT_PROTOCOLS=>$allowHttp ? CURLPROTO_HTTP | CURLPROTO_HTTPS : CURLPROTO_HTTPS, CURLOPT_REDIR_PROTOCOLS=>CURLPROTO_HTTPS,
                CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_SSL_VERIFYHOST=>2,
                CURLOPT_CONNECTTIMEOUT=>5, CURLOPT_TIMEOUT=>20,
                CURLOPT_WRITEFUNCTION=>static function ($curl, string $chunk) use (&$response, &$tooLarge): int {
                    if (strlen($response) + strlen($chunk) > self::MAX_RESPONSE) { $tooLarge = true; return 0; }
                    $response .= $chunk; return strlen($chunk);
                },
            ]);
            if ($body !== null) curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
            $result = curl_exec($handle);
            if ($tooLarge) throw new CafeKdsException('response_too_large');
            if ($result === false) throw new CafeKdsException('connection_failed');
            return ['status'=>(int)curl_getinfo($handle, CURLINFO_RESPONSE_CODE), 'body'=>$response];
        } finally { curl_close($handle); }
    }

    private function exchange(string $route, string $method, array $query = [], ?array $body = null, bool $authorized = true): array
    {
        $url = $this->baseUrl.$route.($query ? '?'.http_build_query($query, '', '&', PHP_QUERY_RFC3986) : '');
        $headers = ['Accept: application/json'];
        if ($body !== null) $headers[] = 'Content-Type: application/json';
        if ($authorized) $headers[] = 'Authorization: Bearer '.$this->token;
        try {
            $response = ($this->transport)($url, $method, $headers, $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        } catch (CafeKdsException $error) { throw $error; }
        catch (Throwable) { throw new CafeKdsException('connection_failed'); }
        if (!is_array($response) || !is_int($response['status'] ?? null) || !is_string($response['body'] ?? null)) throw new CafeKdsException('invalid_response');
        if (strlen($response['body']) > self::MAX_RESPONSE) throw new CafeKdsException('response_too_large');
        $status = $response['status'];
        if ($status < 200 || $status >= 300) {
            $code = match (true) {
                $status === 401 => 'unauthorized', $status === 403 => 'organization_forbidden',
                $status >= 300 && $status < 400 => 'redirect_refused', $status === 429 => 'rate_limited',
                $status >= 500 => 'upstream_unavailable', default => 'request_rejected',
            };
            throw new CafeKdsException($code, $status);
        }
        try { $data = json_decode($response['body'], true, 64, JSON_THROW_ON_ERROR); }
        catch (Throwable) { throw new CafeKdsException('invalid_response', $status); }
        if (!is_array($data)) throw new CafeKdsException('invalid_response', $status);
        return $data;
    }

    private function authenticate(): void
    {
        $data = $this->exchange('/clients/service-token', 'POST', [], ['name'=>$this->name, 'password'=>$this->password], false);
        $token = $data['accessToken'] ?? null;
        if (!is_string($token) || !preg_match('#^[a-zA-Z0-9._~+/=-]{1,16384}$#D', $token)) {
            throw new CafeKdsException('invalid_token');
        }
        $this->token = $token;
    }

    private function read(string $method, array $query = []): array
    {
        if (!in_array($method, self::READ_METHODS, true)) throw new CafeKdsException('unsupported_method');
        if ($this->token === null) $this->authenticate();
        try { return $this->exchange('/external/'.$method, 'GET', $query); }
        catch (CafeKdsException $error) {
            // Only reads may be repeated; exactly one renewal after an expired token.
            if ($error->httpStatus !== 401) throw $error;
            $this->token = null; $this->authenticate();
            return $this->exchange('/external/'.$method, 'GET', $query);
        }
    }

    private function organization(string $id): array
    {
        if (!preg_match('/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iD', $id)) throw new CafeKdsException('invalid_organization');
        if ($this->httpTest && strcasecmp($id, $this->testOrganization) !== 0) throw new CafeKdsException('test_organization_only');
        return ['organizationId'=>$id];
    }
    private static function listResult(array $data): array
    {
        if (!array_is_list($data)) throw new CafeKdsException('invalid_response');
        foreach ($data as $row) if (!is_array($row)) throw new CafeKdsException('invalid_response');
        return $data;
    }
    public function organizations(): array
    {
        // REF permissions may expose several organizations. Discovery is read-only;
        // every organization-specific HTTP call remains pinned by organization().
        return self::listResult($this->read('get-organizations'));
    }
    public function currencies(string $id): array { return self::listResult($this->read('get-currencies', $this->organization($id))); }
    public function periods(string $id): array { return self::listResult($this->read('get-periods', $this->organization($id))); }
    public function menu(string $id, bool $delivery = true): array
    {
        $result = $this->read('get-menu', $this->organization($id) + ['isDelivery'=>$delivery ? 'true' : 'false']);
        if (!is_array($result['groups'] ?? null) || !array_is_list($result['groups']) || !is_array($result['periods'] ?? null) || !array_is_list($result['periods'])) throw new CafeKdsException('invalid_response');
        return $result;
    }
    public function rests(string $id): array
    {
        $result = $this->read('get-dish-rests', $this->organization($id));
        foreach (['forbidden', 'limited'] as $key) if (!is_array($result[$key] ?? null) || !array_is_list($result[$key])) throw new CafeKdsException('invalid_response');
        return $result;
    }
    public function pendingOrder(string $organization, string $pendingId): array
    {
        if (!preg_match('/^[a-zA-Z0-9_{}-]{1,128}$/D', $pendingId)) throw new CafeKdsException('invalid_order_identifier');
        return $this->read('get-pending-order', $this->organization($organization) + ['pendingOrderId'=>$pendingId]);
    }
    public function createPending(array $body): array
    {
        if (!$this->testOrders || ($body['organizationId'] ?? '') !== $this->testOrganization) throw new CafeKdsException('test_orders_only');
        $this->organization($body['organizationId']);
        if (!is_array($body['items'] ?? null) || !array_is_list($body['items']) || !$body['items'] || count($body['items']) > 50) throw new CafeKdsException('invalid_order');
        if ($this->token === null) $this->authenticate();
        // Deliberately no retry, including 401, timeout and malformed responses.
        // Caller durably claims this attempt before invoking the method.
        return $this->exchange('/external/create-order', 'POST', [], $body);
    }
    public function order(string $organization, string $orderGuid): array
    {
        if (!preg_match('/^\{?[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\}?$/iD', $orderGuid)) throw new CafeKdsException('invalid_order_identifier');
        return $this->read('get-order', $this->organization($organization) + ['orderGuid'=>$orderGuid]);
    }
}

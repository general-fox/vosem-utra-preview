<?php
declare(strict_types=1);

final class LoyaltyPhoneError extends RuntimeException {
    public function __construct(public int $status, string $message, public string $reason = 'phone_error', public int $retryAfter = 0) { parent::__construct($message); }
}

final class LoyaltyPhoneTransportError extends RuntimeException {
    public function __construct(public string $reason, string $message) { parent::__construct($message); }
}

/** Only fixed messages are public; never include a raw response, cURL error string or credentials. */
function loyalty_ucaller_response(string|false $raw, int $status, int $error): array {
    if ($error) {
        [$reason,$message] = match ($error) {
            5,6 => ['phone_dns','Хостинг не смог определить адрес сервера uCaller.'],
            7 => ['phone_connect','Хостинг не смог соединиться с сервером uCaller.'],
            28 => ['phone_timeout','Сервер uCaller не ответил хостингу за отведённое время.'],
            35,51,58,59,60,77,80,82,83,90,91 => ['phone_tls','Хостинг не смог установить защищённое соединение с uCaller. Требуется проверить сертификаты PHP/cURL на хостинге.'],
            default => ['phone_transport','Соединение хостинга с uCaller прервалось.'],
        };
        throw new LoyaltyPhoneTransportError($reason,$message);
    }
    if ($status >= 500) throw new LoyaltyPhoneTransportError('phone_http_'.$status,'Сервер uCaller вернул ошибку HTTP '.$status.'.');
    if (!is_string($raw) || strlen($raw) > 65536) throw new LoyaltyPhoneTransportError('phone_response','Не удалось прочитать ответ uCaller.');
    $data = json_decode($raw, true);
    if (!is_array($data) || !is_bool($data['status'] ?? null)) throw new LoyaltyPhoneTransportError('phone_response','uCaller вернул неожиданный ответ (HTTP '.$status.').');
    if ($status !== 200 || $data['status'] !== true) {
        $code = is_numeric($data['code'] ?? null) ? (int)$data['code'] : $status;
        $message = match ($code) {
            0,1003 => 'uCaller запрещает запросы с IP-адреса хостинга. Проверьте ограничения IP в кабинете сервиса.',
            1,2,3 => 'uCaller отклонил параметры запроса. Сообщите администратору код ошибки '.$code.'.',
            4 => 'Сервис uCaller выключен. Включите его в личном кабинете.',
            9 => 'В uCaller запрещены звонки в страну этого номера. Проверьте настройки сервиса.',
            18,19,429 => 'uCaller просит подождать перед повторным запросом.',
            401 => 'uCaller не принял ID сервиса или секретный ключ. Проверьте serviceId и secretKey в закрытом файле.',
            1001 => 'Аккаунт uCaller заблокирован. Проверьте его состояние в личном кабинете.',
            1002 => 'uCaller сообщает о недостаточном балансе. Проверьте баланс и доступность тестовых звонков в кабинете.',
            1004 => 'Сервис uCaller находится в архиве. Проверьте выбранный сервис.',
            1005 => 'Подтвердите номер телефона в личном кабинете uCaller.',
            default => 'uCaller отклонил запрос. Код ошибки: '.$code.'.',
        };
        $limited = in_array($code,[18,19,429],true);
        throw new LoyaltyPhoneError($limited ? 429 : 503,$message,'provider_'.$code,$limited ? 180 : 0);
    }
    return $data;
}

function loyalty_phone_config(string $privateRoot, string $origin): array {
    $policyFile = $privateRoot.'/loyalty-phone-policy.php';
    $configFile = $privateRoot.'/ucaller-config.json';
    $policy = is_file($policyFile) ? require $policyFile : [];
    if (!is_array($policy)) throw new LoyaltyPhoneError(503, 'Не удалось прочитать настройки режима подтверждения телефона.', 'phone_config_policy');
    if (!($policy['required'] ?? false) && !is_file($configFile)) return ['enabled'=>false];
    if (!is_file($configFile)) throw new LoyaltyPhoneError(503, 'На сервере не найден закрытый файл ucaller-config.json. Администратору нужно загрузить его в папку vosem-utra-private рядом с папкой сайта.', 'phone_config_missing');
    $raw = @file_get_contents($configFile);
    if ($raw === false) throw new LoyaltyPhoneError(503, 'Сервер не может прочитать ucaller-config.json. Администратору нужно проверить права доступа к файлу.', 'phone_config_unreadable');
    // Windows editors can prepend a UTF-8 BOM; it is not part of JSON or the secret.
    if (str_starts_with($raw, "\xEF\xBB\xBF")) $raw = substr($raw, 3);
    try { $config = json_decode($raw, true, 16, JSON_THROW_ON_ERROR); }
    catch (Throwable) { throw new LoyaltyPhoneError(503, 'Не удалось прочитать JSON в ucaller-config.json. Проверьте кавычки, запятые и сохранение файла в UTF-8.', 'phone_config_json'); }
    if (!is_array($config) || array_is_list($config)) throw new LoyaltyPhoneError(503, 'В ucaller-config.json должен находиться объект с полями настроек.', 'phone_config_json');
    $serviceValue = $config['serviceId'] ?? '';
    $service = is_string($serviceValue) || is_int($serviceValue) ? trim((string)$serviceValue) : '';
    if (!preg_match('/^[1-9][0-9]{0,15}$/D', $service)) throw new LoyaltyPhoneError(503, 'В ucaller-config.json не заполнен или неверно указан serviceId — ID сервиса uCaller.', 'phone_config_service');
    $key = is_string($config['secretKey'] ?? null) ? trim($config['secretKey']) : '';
    if (strlen($key) < 8 || strlen($key) > 512 || preg_match('/[\s\x00-\x1f\x7f]/', $key)) throw new LoyaltyPhoneError(503, 'В ucaller-config.json не заполнен или неверно указан secretKey — сервисный ключ uCaller.', 'phone_config_secret');
    $mode = $config['mode'] ?? '';
    if (!in_array($mode, ['test','live'], true) || (($policy['testOnly'] ?? false) && $mode !== 'test')) throw new LoyaltyPhoneError(503, 'Проверьте поле mode в ucaller-config.json. Для тестовой сборки требуется test.', 'phone_config_mode');
    $expected = is_string($config['publicOrigin'] ?? null) ? rtrim(trim($config['publicOrigin']), '/') : '';
    if (!preg_match('~^https://[a-z0-9.-]+$~D', $expected) || $origin !== $expected
        || (isset($policy['publicOrigin']) && $policy['publicOrigin'] !== $expected)
        || ($mode === 'test' && $expected !== 'https://test888.ru') || ($mode === 'live' && $expected === 'https://test888.ru')) {
        throw new LoyaltyPhoneError(503, 'Адрес сайта не совпадает с publicOrigin в ucaller-config.json. Для теста используйте https://test888.ru.', 'phone_config_origin');
    }
    $trustedValue = $config['trustedPhone'] ?? '';
    $trusted = is_string($trustedValue) || is_int($trustedValue) ? preg_replace('/\D/', '', (string)$trustedValue) : '';
    if ($mode === 'test' && !preg_match('/^7[0-9]{10}$/D', $trusted)) throw new LoyaltyPhoneError(503, 'В ucaller-config.json укажите trustedPhone — доверенный тестовый номер в формате 79XXXXXXXXX.', 'phone_config_phone');
    $limit = $config['dailyCallLimit'] ?? ($mode === 'test' ? 10 : 100);
    if (!is_int($limit) || $limit < 1 || $limit > 10000) throw new LoyaltyPhoneError(503, 'Проверьте dailyCallLimit в ucaller-config.json: нужно целое число от 1 до 10000 без кавычек.', 'phone_config_limit');
    return ['enabled'=>true,'serviceId'=>$service,'secretKey'=>$key,'mode'=>$mode,'trustedPhone'=>$trusted,'publicOrigin'=>$expected,'dailyCallLimit'=>$limit];
}

/** Fixed HTTPS destination; neither credentials, full phone nor provider response is logged. */
function loyalty_ucaller_request(array $config, string $method, array $body = []): array {
    if (!in_array($method, ['initCall','getService'], true)) throw new RuntimeException('phone_method_not_allowed');
    if (!function_exists('curl_init')) throw new LoyaltyPhoneTransportError('phone_curl_missing','В PHP на хостинге не включено расширение cURL.');
    $curl = curl_init('https://api.ucaller.ru/v1.0/'.$method);
    curl_setopt_array($curl, [CURLOPT_POST=>true, CURLOPT_POSTFIELDS=>json_encode($body ?: new stdClass(), JSON_THROW_ON_ERROR),
        CURLOPT_HTTPHEADER=>['Content-Type: application/json','Accept: application/json','Authorization: Bearer '.$config['secretKey'].'.'.$config['serviceId']],
        CURLOPT_RETURNTRANSFER=>true, CURLOPT_CONNECTTIMEOUT=>5, CURLOPT_TIMEOUT=>15, CURLOPT_FOLLOWLOCATION=>false,
        CURLOPT_SSL_VERIFYPEER=>true, CURLOPT_SSL_VERIFYHOST=>2, CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS]);
    $raw = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE); $error = curl_errno($curl); curl_close($curl);
    return loyalty_ucaller_response($raw,$status,$error);
}

final class LoyaltyPhone {
    private PDO $db;
    private Closure $transport;
    private Closure $clock;
    public function __construct(private array $config, string $privateRoot, ?callable $transport = null, ?callable $clock = null) {
        $this->transport = Closure::fromCallable($transport ?? 'loyalty_ucaller_request');
        $this->clock = Closure::fromCallable($clock ?? 'time');
        $directory = $privateRoot.'/phone-data';
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) throw new RuntimeException('phone_storage_unavailable');
        $this->db = new PDO('sqlite:'.$directory.'/limits.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
        $this->db->exec('PRAGMA busy_timeout=5000');
        $this->db->exec('CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)');
        @chmod($directory.'/limits.sqlite', 0600);
    }
    private function now(): int { return ($this->clock)(); }
    private function hash(string $value): string { return hash_hmac('sha256', $value, $this->config['secretKey']); }
    private function phone(string $value): string {
        $phone = preg_replace('/\D/', '', $value);
        if (!preg_match('/^7[0-9]{10}$/D', $phone)) throw new LoyaltyPhoneError(422, 'Введите номер телефона: +7 и 10 цифр.');
        if ($this->config['mode'] === 'test' && !hash_equals($this->config['trustedPhone'], $phone)) throw new LoyaltyPhoneError(422, 'На тестовом сайте звонок доступен только на доверенный тестовый номер.', 'test_number_only');
        if ($this->config['mode'] === 'live' && in_array($phone, ['79000000001','79000000002'], true)) throw new LoyaltyPhoneError(422, 'Укажите настоящий номер телефона.');
        return $phone;
    }
    private function scope(): string { return $this->hash($this->config['serviceId'].'|'.$this->config['publicOrigin'].'|'.$this->config['mode']); }
    /** A secret-derived code allows transport retries with exactly the same UUID and code, without storing a readable code. */
    private function code(array $challenge): string { return str_pad((string)(hexdec(substr($this->hash('code:'.$challenge['id']), 0, 8)) % 9999 + 1), 4, '0', STR_PAD_LEFT); }
    private function matches(array $challenge, string $phone): bool {
        return ($challenge['scope'] ?? '') === $this->scope() && hash_equals($challenge['phoneKey'] ?? '', $this->hash('phone:'.$phone));
    }
    private function uuid(): string {
        $b = random_bytes(16); $b[6] = chr((ord($b[6]) & 0x0f) | 0x40); $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        $h = bin2hex($b); return substr($h,0,8).'-'.substr($h,8,4).'-'.substr($h,12,4).'-'.substr($h,16,4).'-'.substr($h,20);
    }
    private function rates(array $limits): void {
        $now = $this->now(); $this->db->exec('BEGIN IMMEDIATE');
        try {
            $delete = $this->db->prepare('DELETE FROM limits WHERE expires<=?'); $delete->execute([$now]);
            $read = $this->db->prepare('SELECT count,expires FROM limits WHERE bucket=?');
            $rows = []; $wait = 0;
            foreach ($limits as [$name,$max,$seconds]) {
                $key = $this->hash('limit:'.$name); $read->execute([$key]); $row = $read->fetch(PDO::FETCH_ASSOC);
                if ($row && $row['count'] >= $max) $wait = max($wait, (int)$row['expires']-$now);
                $rows[] = [$key, $row ? (int)$row['count']+1 : 1, $row ? (int)$row['expires'] : $now+$seconds];
            }
            if ($wait > 0) throw new LoyaltyPhoneError(429, 'Достигнут лимит попыток. Повторите позже.', 'phone_rate_limit', $wait);
            $write = $this->db->prepare('INSERT OR REPLACE INTO limits(bucket,count,expires) VALUES(?,?,?)');
            foreach ($rows as $row) $write->execute($row);
            $this->db->exec('COMMIT');
        } catch (Throwable $e) { $this->db->exec('ROLLBACK'); throw $e; }
    }
    public function publicState(array $challenge): array {
        return ['challengeId'=>$challenge['id'],'phoneMask'=>$challenge['mask'],'expiresIn'=>max(0,$challenge['expires']-$this->now()),
            'retryAfter'=>max(0,$challenge['nextCall']-$this->now()),'verified'=>in_array($challenge['status'],['verified','consumed'],true),
            'pending'=>$challenge['status']==='pending','testMode'=>$this->config['mode']==='test',
            'connectionMessage'=>$this->config['mode']==='test' ? ($challenge['connectionMessage'] ?? '') : ''];
    }
    public function checkConnection(string $ip): array {
        if ($this->config['mode'] !== 'test') throw new LoyaltyPhoneError(404,'Проверка доступна только на тестовом сайте.','not_found');
        $this->rates([['diagnostics-ip:'.$ip,3,60],['diagnostics-global',6,60]]);
        try { $result = ($this->transport)($this->config,'getService',[]); }
        catch (LoyaltyPhoneTransportError $e) { throw new LoyaltyPhoneError(503,$e->getMessage(),$e->reason); }
        if (($result['status'] ?? false) !== true) throw new LoyaltyPhoneError(503,'uCaller не подтвердил доступ к сервису.','phone_response');
        return ['connected'=>true,'callsStarted'=>0,'message'=>'Соединение с uCaller работает, ID и ключ приняты. Проверочный звонок не запускался.'];
    }
    public function start(array &$session, string $value, string $ip, bool $resend = false): array {
        $phone = $this->phone($value); $now = $this->now(); $previous = $session['phoneChallenge'] ?? [];
        $same = $this->matches($previous, $phone) && ($previous['expires'] ?? 0) > $now;
        if ($same && in_array($previous['status'], ['sent','pending','verified','consumed'],true) && !$resend) return $this->publicState($previous);
        if ($same && $previous['nextCall'] > $now) throw new LoyaltyPhoneError(429, 'Подождите перед повторным звонком. Полученный код можно ввести сейчас.', 'phone_wait', $previous['nextCall']-$now);
        if ($same && $previous['status'] === 'pending') {
            // A timeout is not evidence of failure: recover the existing request without another charge.
            $challenge = $previous; $challenge['nextCall'] = $now+60;
        } else {
            $this->rates([['phone-minute:'.$phone,1,60],['phone-hour:'.$phone,5,3600],['ip-hour:'.$ip,12,3600],['calls-day', $this->config['dailyCallLimit'],86400]]);
            $challenge = ['id'=>bin2hex(random_bytes(16)),'unique'=>$this->uuid(),'scope'=>$this->scope(),'phoneKey'=>$this->hash('phone:'.$phone),
                'mask'=>'+7 ••• •••-'.substr($phone,-4,2).'-'.substr($phone,-2),'expires'=>$now+300,'nextCall'=>$now+60,'status'=>'pending','attempts'=>0];
        }
        $session['phoneChallenge'] = $challenge;
        // Persist the UUID before the external request. A terminated PHP worker must not cause a second charge on retry.
        if (session_status() === PHP_SESSION_ACTIVE) {
            if (!session_write_close() || !session_start() || ($session['phoneChallenge']['id'] ?? '') !== $challenge['id']) throw new LoyaltyPhoneError(409,'Сессия изменилась. Обновите страницу.');
        }
        try {
            $response = ($this->transport)($this->config, 'initCall', ['phone'=>PHP_INT_SIZE >= 8 ? (int)$phone : (float)$phone,'code'=>$this->code($challenge),'unique'=>$challenge['unique']]);
            if (($response['status'] ?? false) !== true || !isset($response['ucaller_id']) || !hash_equals($this->code($challenge),(string)($response['code'] ?? ''))) throw new RuntimeException('phone_response_unknown');
            $session['phoneChallenge']['status'] = 'sent';
            unset($session['phoneChallenge']['connectionMessage']);
        } catch (LoyaltyPhoneError $e) {
            $session['phoneChallenge']['status'] = 'failed'; throw $e;
        } catch (LoyaltyPhoneTransportError $e) {
            $session['phoneChallenge']['connectionMessage'] = $e->getMessage();
        } catch (Throwable) {
            // The call may already be arriving. The code remains verifiable and repeats reuse the same UUID.
            $session['phoneChallenge']['connectionMessage'] = 'Не удалось подтвердить результат запроса uCaller.';
        }
        return $this->publicState($session['phoneChallenge']);
    }
    public function verify(array &$session, string $value, string $id, string $code, string $ip): array {
        $phone = $this->phone($value); $challenge = $session['phoneChallenge'] ?? [];
        if (!$this->matches($challenge,$phone) || !hash_equals($challenge['id'] ?? '',$id) || ($challenge['expires'] ?? 0) <= $this->now()
            || !in_array($challenge['status'] ?? '', ['sent','pending','verified'],true)) throw new LoyaltyPhoneError(422, 'Запросите новый звонок для этого номера.', 'phone_expired');
        if ($challenge['status'] === 'verified') return $this->publicState($challenge);
        // Shared limits also cover new sessions; a code cannot be brute-forced by discarding cookies.
        $this->rates([['verify-phone:'.$phone,5,180],['verify-ip:'.$ip,20,180]]);
        $session['phoneChallenge']['attempts']++;
        if (!preg_match('/^[0-9]{4}$/D',$code) || !hash_equals($this->code($challenge),$code)) {
            if ($session['phoneChallenge']['attempts'] >= 5) $session['phoneChallenge']['status']='locked';
            throw new LoyaltyPhoneError(422, 'Код не подошёл. Введите последние четыре цифры номера входящего звонка.', 'phone_code_invalid');
        }
        $session['phoneChallenge']['status']='verified';
        return $this->publicState($session['phoneChallenge']);
    }
    public function requireVerified(array $session, string $value): void {
        $phone = $this->phone($value); $challenge = $session['phoneChallenge'] ?? [];
        if (!$this->matches($challenge,$phone) || ($challenge['expires'] ?? 0) <= $this->now() || ($challenge['status'] ?? '') !== 'verified')
            throw new LoyaltyPhoneError(422, 'Сначала подтвердите номер телефона звонком.', 'phone_confirmation_required');
    }
    public function consume(array &$session, string $value): void { $this->requireVerified($session,$value); $session['phoneChallenge']['status']='consumed'; }
}

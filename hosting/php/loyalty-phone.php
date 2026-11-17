<?php
declare(strict_types=1);

final class LoyaltyPhoneError extends RuntimeException {
    public function __construct(public int $status, string $message, public string $reason = 'phone_error', public int $retryAfter = 0) { parent::__construct($message); }
}
final class LoyaltyPhoneTransportError extends RuntimeException {}

function loyalty_phone_config(string $privateRoot, string $origin): array {
    $policyFile=$privateRoot.'/loyalty-phone-policy.php';
    $policy=is_file($policyFile) ? require $policyFile : [];
    if (!is_array($policy) || ($policy['provider'] ?? '')!=='flashcall' || !is_bool($policy['testOnly'] ?? null)
        || ($policy['publicOrigin'] ?? '')!==($policy['testOnly'] ? 'https://test888.ru' : 'https://vosem-utra.ru'))
        throw new LoyaltyPhoneError(503,'Настройки подтверждения телефона не соответствуют сборке. Обновите все файлы из архива.','phone_config_policy');
    $file=$privateRoot.'/flashcall-config.json';
    if (!is_file($file)) throw new LoyaltyPhoneError(503,'Добавьте flashcall-config.json в закрытую папку vosem-utra-private.','phone_config_missing');
    $raw=@file_get_contents($file);
    if ($raw===false) throw new LoyaltyPhoneError(503,'Не удалось прочитать настройки FlashCall.','phone_config_unreadable');
    if (str_starts_with($raw,"\xEF\xBB\xBF")) $raw=substr($raw,3);
    try { $config=json_decode($raw,true,16,JSON_THROW_ON_ERROR); }
    catch (Throwable) { throw new LoyaltyPhoneError(503,'Проверьте формат JSON в flashcall-config.json.','phone_config_json'); }
    $key=is_array($config) && is_string($config['apiKey'] ?? null) ? trim($config['apiKey']) : '';
    if (strlen($key)<8 || strlen($key)>512 || preg_match('/[\s\x00-\x1f\x7f]/',$key)) throw new LoyaltyPhoneError(503,'Заполните apiKey в закрытом файле flashcall-config.json.','phone_config_key');
    $expected=is_string($config['publicOrigin'] ?? null) ? rtrim(trim($config['publicOrigin']),'/') : '';
    if ($expected!==$origin || ($policy['publicOrigin'] ?? '')!==$origin)
        throw new LoyaltyPhoneError(503,'Домен в настройках FlashCall не соответствует этой сборке сайта.','phone_config_origin');
    $limit=$config['dailyCallLimit'] ?? 10;
    if (!is_int($limit) || $limit<0 || $limit>10000) throw new LoyaltyPhoneError(503,'В dailyCallLimit укажите целое число от 0 до 10000. Ноль отключает общий суточный лимит.','phone_config_limit');
    return ['enabled'=>true,'provider'=>'flashcall','apiKey'=>$key,'publicOrigin'=>$expected,'dailyCallLimit'=>$limit,'testOnly'=>$policy['testOnly']];
}

/** Never disclose provider bodies, tokens, URLs or raw cURL errors. */
function loyalty_flashcall_response(string|false $raw, int $status, int $error): array {
    if ($error || $raw===false || strlen($raw)>65536) throw new LoyaltyPhoneTransportError('Не удалось получить ответ FlashCall.');
    if ($status===429) throw new LoyaltyPhoneError(429,'Сервис просит подождать перед новой проверкой.','provider_rate_limit',60);
    if (in_array($status,[401,403,404],true)) throw new LoyaltyPhoneError(503,'FlashCall не принял запрос. Проверьте API-ключ проекта.','provider_access');
    if ($status===400) throw new LoyaltyPhoneError(503,'FlashCall отклонил запрос. Проверьте номер и баланс проекта.','provider_rejected');
    // The live get-phone endpoint returns 201 Created; status returns 200 OK.
    if (!in_array($status,[200,201],true)) throw new LoyaltyPhoneTransportError('FlashCall временно недоступен.');
    $data=json_decode($raw,true);
    if (!is_array($data) || array_is_list($data)) throw new LoyaltyPhoneTransportError('Не удалось прочитать ответ FlashCall.');
    return $data;
}

/** Fixed documented endpoints, TLS verification, no redirects or automatic retries. */
function loyalty_flashcall_request(array $config, string $method, array $body=[]): array {
    if (!in_array($method,['get-phone','status'],true)) throw new RuntimeException('phone_method_not_allowed');
    if (!function_exists('curl_init')) throw new LoyaltyPhoneTransportError('В PHP не включено расширение cURL.');
    $url='https://flashcall.ru/api/v1/'.$method;
    if ($method==='status') $url.='?'.http_build_query(['token'=>$config['apiKey'],'id'=>$body['id']],'','&',PHP_QUERY_RFC3986);
    $curl=curl_init($url); $raw='';
    curl_setopt_array($curl,[CURLOPT_HTTPHEADER=>['Accept: application/json','Content-Type: application/json'],
        CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>10,CURLOPT_FOLLOWLOCATION=>false,
        CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,
        CURLOPT_WRITEFUNCTION=>static function($curl,string $chunk) use (&$raw): int {
            if (strlen($raw)+strlen($chunk)>65536) return 0;
            $raw.=$chunk; return strlen($chunk);
        }]);
    if (PHP_OS_FAMILY==='Windows' && defined('CURLSSLOPT_NATIVE_CA')) curl_setopt($curl,CURLOPT_SSL_OPTIONS,CURLSSLOPT_NATIVE_CA);
    if ($method==='get-phone') curl_setopt_array($curl,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode(['token'=>$config['apiKey'],'phone'=>$body['phone']],JSON_THROW_ON_ERROR)]);
    curl_exec($curl); $status=(int)curl_getinfo($curl,CURLINFO_RESPONSE_CODE); $error=curl_errno($curl); curl_close($curl);
    return loyalty_flashcall_response($raw,$status,$error);
}

final class LoyaltyPhone {
    private PDO $db;
    private Closure $transport;
    private Closure $clock;
    public function __construct(private array $config, string $privateRoot, ?callable $transport=null, ?callable $clock=null) {
        $this->transport=Closure::fromCallable($transport ?? 'loyalty_flashcall_request');
        $this->clock=Closure::fromCallable($clock ?? 'time');
        $directory=$privateRoot.'/phone-data';
        if (!is_dir($directory) && !mkdir($directory,0700,true) && !is_dir($directory)) throw new RuntimeException('phone_storage_unavailable');
        $this->db=new PDO('sqlite:'.$directory.'/limits.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
        $this->db->exec('PRAGMA busy_timeout=5000');
        $this->db->exec('CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)');
        $this->db->exec('CREATE TABLE IF NOT EXISTS flashcall_reservations (provider_key TEXT PRIMARY KEY, owner TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL)');
        @chmod($directory.'/limits.sqlite',0600);
    }
    private function now(): int { return ($this->clock)(); }
    private function hash(string $value): string { return hash_hmac('sha256','flashcall:'.$value,$this->config['apiKey']); }
    private function phone(string $value): string {
        $phone=preg_replace('/\D/','',$value);
        if (!preg_match('/^7[0-9]{10}$/D',$phone)) throw new LoyaltyPhoneError(422,'Введите номер телефона: +7 и 10 цифр.');
        return '+'.$phone;
    }
    private function matches(array $challenge,string $phone): bool {
        return ($challenge['scope'] ?? '')===$this->hash($this->config['publicOrigin']) && hash_equals($challenge['phoneKey'] ?? '',$this->hash('phone:'.$phone));
    }
    public function publicState(array $challenge): array {
        $verified=$challenge['status']==='verified' && ($challenge['proofExpires'] ?? 0)>$this->now();
        return ['challengeId'=>$challenge['id'],'method'=>'incoming','phoneMask'=>$challenge['mask'],
            'phoneToCall'=>$challenge['status']==='waiting' && $challenge['expires']>$this->now() ? ($challenge['destination'] ?? '') : '',
            'expiresIn'=>max(0,$challenge['expires']-$this->now()),'retryAfter'=>max(0,$challenge['nextCall']-$this->now()),
            'verified'=>$verified,'proofExpiresIn'=>$verified ? $challenge['proofExpires']-$this->now() : 0,
            'state'=>$challenge['status'],'testMode'=>($this->config['testOnly'] ?? true),'connectionMessage'=>$challenge['message'] ?? ''];
    }
    private function rates(array $limits): void {
        $now=$this->now(); $this->db->exec('BEGIN IMMEDIATE');
        try {
            $this->db->prepare('DELETE FROM limits WHERE expires<=?')->execute([$now]);
            $this->db->prepare('DELETE FROM flashcall_reservations WHERE expires<=?')->execute([$now]);
            $read=$this->db->prepare('SELECT count,expires FROM limits WHERE bucket=?'); $rows=[]; $wait=0; $budgetExhausted=false;
            foreach ($limits as [$name,$max,$seconds]) {
                $key=$this->hash('limit:'.$name); $read->execute([$key]); $row=$read->fetch(PDO::FETCH_ASSOC);
                if ($row && $row['count']>=$max) {
                    if ($name==='checks-day') $budgetExhausted=true;
                    else $wait=max($wait,(int)$row['expires']-$now);
                }
                $rows[]=[$key,$row ? (int)$row['count']+1 : 1,$row ? (int)$row['expires'] : $now+$seconds];
            }
            // This is the site's shared spending cap, not a visitor-specific cooldown.
            // Keep it enforced without presenting hours of waiting as a personal block.
            if ($budgetExhausted) throw new LoyaltyPhoneError(503,'Подтверждение номера временно недоступно. Попробуйте позже или свяжитесь с кофейней.','phone_budget_exhausted');
            if ($wait>0) throw new LoyaltyPhoneError(429,'Достигнут лимит проверок. Повторите позже.','phone_rate_limit',$wait);
            $write=$this->db->prepare('INSERT OR REPLACE INTO limits(bucket,count,expires) VALUES(?,?,?)');
            foreach ($rows as $row) $write->execute($row);
            $this->db->exec('COMMIT');
        } catch (Throwable $e) { $this->db->exec('ROLLBACK'); throw $e; }
    }
    private function claim(string $providerId,string $owner): void {
        // Pending requests are deduplicated by phone. One provider proof must belong to one browser challenge.
        $key=$this->hash('reservation:'.$providerId);
        $this->db->prepare('INSERT OR IGNORE INTO flashcall_reservations(provider_key,owner,expires) VALUES(?,?,?)')->execute([$key,$owner,$this->now()+86400]);
        $read=$this->db->prepare('SELECT owner,consumed FROM flashcall_reservations WHERE provider_key=?'); $read->execute([$key]);
        $row=$read->fetch(PDO::FETCH_ASSOC);
        if (!$row || $row['owner']!==$owner || $row['consumed']) throw new LoyaltyPhoneError(409,'Проверка уже открыта в другой вкладке или завершена. Дождитесь окончания минуты и начните новую.','phone_already_claimed',60);
    }
    public function start(array &$session,string $value,string $ip,bool $resend=false): array {
        $phone=$this->phone($value); $now=$this->now(); $previous=$session['flashcallChallenge'] ?? [];
        if ($this->matches($previous,$phone)) {
            if ($previous['status']==='waiting' && $previous['expires']<=$now) {
                $this->status($session,$phone,$previous['id'],$ip); $previous=$session['flashcallChallenge'];
            }
            if ($previous['status']==='verified' && ($previous['proofExpires'] ?? 0)<=$now) {
                $previous['status']='expired'; $session['flashcallChallenge']=$previous;
            }
            $terminal=in_array($previous['status'],['expired','consumed'],true);
            // A fresh explicit start after completion/reload may create a new check.
            // Unknown outcomes still require an explicit resend, and all new checks pass rates below.
            if ($previous['status']==='verified' || (!$terminal && (!$resend || $previous['nextCall']>$now || $previous['status']==='waiting')))
                return $this->publicState($previous);
            if ($terminal && $previous['nextCall']>$now)
                throw new LoyaltyPhoneError(429,'Достигнут лимит проверок. Повторите позже.','phone_rate_limit',$previous['nextCall']-$now);
        }
        $limits=[['phone-minute:'.$phone,1,60],['phone-hour:'.$phone,5,3600],['ip-hour:'.$ip,12,3600]];
        // Zero disables only the site's daily spending cap; per-number/IP protection remains.
        if (($this->config['dailyCallLimit'] ?? 10)>0) $limits[]=['checks-day',$this->config['dailyCallLimit'] ?? 10,86400];
        $this->rates($limits);
        $challenge=['id'=>bin2hex(random_bytes(16)),'scope'=>$this->hash($this->config['publicOrigin']),'phoneKey'=>$this->hash('phone:'.$phone),
            'mask'=>'+7 ••• •••-'.substr($phone,-4,2).'-'.substr($phone,-2),'expires'=>$now+60,'nextCall'=>$now+60,'status'=>'unknown','polledAt'=>0];
        $session['flashcallChallenge']=$challenge;
        unset($session['phoneChallenge'],$session['zvonokChallenge'],$session['hybridChallenge']);
        // Persist before the external request to prevent silent retries after an interrupted worker.
        if (session_status()===PHP_SESSION_ACTIVE) {
            if (!session_write_close() || !session_start()) throw new LoyaltyPhoneError(409,'Сессия изменилась. Обновите страницу.');
            $session =& $_SESSION;
            if (($session['flashcallChallenge']['id'] ?? '')!==$challenge['id']) throw new LoyaltyPhoneError(409,'Сессия изменилась. Обновите страницу.');
        }
        $current =& $session['flashcallChallenge'];
        try {
            $data=($this->transport)($this->config,'get-phone',['phone'=>$phone]);
            if (!is_string($data['id'] ?? null) || !preg_match('/^[a-zA-Z0-9_-]{1,128}$/D',$data['id'])
                || !is_string($data['phone'] ?? null) || !preg_match('/^\+7[0-9]{10}$/D',$data['phone'])
                || !is_int($data['expiresIn'] ?? null) || $data['expiresIn']<1 || $data['expiresIn']>60)
                throw new LoyaltyPhoneTransportError('Некорректный ответ FlashCall.');
            $this->claim($data['id'],$challenge['id']);
            $current['providerId']=$data['id']; $current['destination']=$data['phone'];
            $current['expires']=$now+$data['expiresIn'];
            $current['status']='waiting';
        } catch (LoyaltyPhoneError $e) {
            $current['status']='failed'; $current['message']=$e->getMessage(); $current['nextCall']=max($now+60,$now+$e->retryAfter);
        } catch (Throwable) {
            $current['status']='unknown'; $current['message']='Не удалось получить проверочный номер. Дождитесь окончания таймера и повторите запрос.';
        }
        return $this->publicState($current);
    }
    public function status(array &$session,string $value,string $id,string $ip): array {
        $phone=$this->phone($value); $current =& $session['flashcallChallenge'];
        if (!is_array($current) || !$this->matches($current,$phone) || !hash_equals($current['id'] ?? '',$id))
            throw new LoyaltyPhoneError(422,'Начните проверку этого номера заново.','phone_session');
        if ($current['status']==='verified' && ($current['proofExpires'] ?? 0)<=$this->now()) $current['status']='expired';
        if ($current['status']!=='waiting') return $this->publicState($current);
        // Read the final result even after the call timer: the guest may be returning from the dialler.
        if ($this->now()>$current['expires']+300) { $current['status']='expired'; return $this->publicState($current); }
        if ($current['polledAt']+2>$this->now()) return $this->publicState($current);
        $this->rates([['poll-ip:'.$ip,90,60]]); $current['polledAt']=$this->now();
        try {
            $data=($this->transport)($this->config,'status',['id'=>$current['providerId']]);
            if (($data['id'] ?? null)!==$current['providerId'] || ($data['callerPhone'] ?? null)!==$phone
                || !in_array($data['status'] ?? null,['PENDING','CONFIRMED','EXPIRED'],true)
                || !is_int($data['expiresIn'] ?? null) || $data['expiresIn']<0 || $data['expiresIn']>60)
                throw new LoyaltyPhoneTransportError('Некорректный статус FlashCall.');
            if ($data['status']==='CONFIRMED') {
                $this->claim($current['providerId'],$current['id']);
                $current['status']='verified'; $current['proofExpires']=min($this->now()+300,$current['expires']+300);
            } elseif ($data['status']==='EXPIRED' || $this->now()>=$current['expires'] || $data['expiresIn']===0) $current['status']='expired';
            else $current['expires']=min($current['expires'],$this->now()+$data['expiresIn']);
            unset($current['message']);
        } catch (Throwable) {
            $current['message']='Не удалось уточнить результат. Проверьте соединение и нажмите «Проверить звонок».';
            if ($this->now()>=$current['expires']) $current['status']='failed';
        }
        return $this->publicState($current);
    }
    public function requireVerified(array $session,string $value): void {
        $phone=$this->phone($value); $challenge=$session['flashcallChallenge'] ?? [];
        if (!$this->matches($challenge,$phone) || ($challenge['proofExpires'] ?? 0)<=$this->now() || ($challenge['status'] ?? '')!=='verified')
            throw new LoyaltyPhoneError(422,'Сначала подтвердите номер телефона звонком.','phone_confirmation_required');
        $this->claim($challenge['providerId'],$challenge['id']);
    }
    public function consume(array &$session,string $value): void {
        $this->requireVerified($session,$value); $challenge =& $session['flashcallChallenge'];
        $update=$this->db->prepare('UPDATE flashcall_reservations SET consumed=1 WHERE provider_key=? AND owner=? AND consumed=0');
        $update->execute([$this->hash('reservation:'.$challenge['providerId']),$challenge['id']]);
        if ($update->rowCount()!==1) throw new LoyaltyPhoneError(409,'Эта проверка уже использована.','phone_consumed');
        $challenge['status']='consumed';
    }
}

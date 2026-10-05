<?php
declare(strict_types=1);
require_once __DIR__.'/core.php';

/** A private encrypted outbox keeps SMTP latency out of the public recovery endpoint. */
final class CafeResetMail
{
    private string $directory;
    private string $key;
    public function __construct(string $privateDir, private array $settings, array $config)
    {
        $key = $config['encryption_key'] ?? $config['encryptionKey'] ?? '';
        $key = is_string($key) && preg_match('/\A[a-f0-9]{64}\z/i', $key) ? hex2bin($key) : base64_decode((string)$key, true);
        if (!is_string($key) || strlen($key) !== 32) throw new RuntimeException('Mail encryption is not configured.');
        $this->key = $key;
        $from = $settings['from'] ?? '';
        if (!is_string($from) || !filter_var($from, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $from)) throw new RuntimeException('Invalid mail sender.');
        if (($settings['transport'] ?? '') !== 'smtp' || !is_string($settings['host'] ?? null)
            || !preg_match('/\A[a-z0-9.-]+\z/i', $settings['host'])
            || !in_array($settings['encryption'] ?? '', ['smtps','starttls'], true)
            || !is_int($settings['port'] ?? null) || $settings['port'] < 1 || $settings['port'] > 65535
            || !is_string($settings['username'] ?? null) || $settings['username'] === ''
            || !is_string($settings['password'] ?? null) || $settings['password'] === '') throw new RuntimeException('Invalid SMTP configuration.');
        $resolved = realpath($privateDir);
        // CLI cron has no document root. realpath('') resolves the working directory,
        // which may be the hosting account's home and contain the private directory.
        $documentRoot = $config['document_root'] ?? ($_SERVER['DOCUMENT_ROOT'] ?? '');
        $public = is_string($documentRoot) && $documentRoot !== '' ? realpath($documentRoot) : false;
        if (!$resolved || ($public && (strtolower($resolved) === strtolower($public) || str_starts_with(strtolower(str_replace('\\','/',$resolved)), rtrim(strtolower(str_replace('\\','/',$public)), '/').'/')))) throw new RuntimeException('Mail storage must be private.');
        $this->directory = $resolved.'/admin-data/reset-mail';
        if (!is_dir($this->directory) && !mkdir($this->directory, 0700, true) && !is_dir($this->directory)) throw new RuntimeException('Mail storage unavailable.');
    }
    private function files(): array { return glob($this->directory.'/*.json') ?: []; }
    /** Fixed identifiers only: never copy raw SMTP replies, addresses or credentials to reports. */
    public static function diagnosticCode(Throwable $error): string
    {
        $message = strtolower($error->getMessage());
        if ($error instanceof JsonException) return 'invalid_json';
        if (str_contains($message, 'authenticate')) return 'smtp_authentication';
        if (str_contains($message, 'certificate') || str_contains($message, 'crypto')) return 'smtp_tls';
        if (str_contains($message, 'connect') || str_contains($message, 'timed out')) return 'smtp_connection';
        if (str_contains($message, 'from failed')) return 'smtp_sender';
        if (str_contains($message, 'recipient')) return 'smtp_recipient';
        if (str_contains($message, 'mail storage must be private')) return 'mail_storage_public';
        if (str_contains($message, 'mail encryption')) return 'mail_encryption';
        if (str_contains($message, 'smtp configuration') || str_contains($message, 'mail sender')) return 'smtp_configuration';
        if (str_contains($message, 'not configured')) return 'mail_not_configured';
        if (str_contains($message, 'queued mail')) return 'queue_decryption';
        if ($error instanceof CafeAuthException && $error->errorCode === 'auth_busy') return 'worker_busy';
        if (str_contains($message, 'storage') || str_contains($message, 'lock')) return 'mail_storage';
        return 'mail_send_or_runtime';
    }
    public function enqueue(string $to, string $subject, string $body): bool
    {
        if (!filter_var($to, FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n]/', $to.$subject) || strlen($body) > 12000) return false;
        return CafeStorage::locked($this->directory.'/queue.lock', function () use ($to,$subject,$body): bool {
            $files = $this->files();
            foreach ($files as $file) if ((CafeStorage::readJson($file)['expiresAt'] ?? 0) <= time()) unlink($file);
            if (count($this->files()) >= 100) return false;
            $id = bin2hex(random_bytes(16)); $iv = random_bytes(12); $tag = '';
            $text = json_encode(['to'=>$to,'subject'=>$subject,'body'=>$body], JSON_THROW_ON_ERROR);
            $cipher = openssl_encrypt($text, 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $iv, $tag, 'cafe-reset-mail:'.$id, 16);
            if ($cipher === false) return false;
            CafeStorage::atomicJson($this->directory.'/'.$id.'.json', ['id'=>$id, 'iv'=>bin2hex($iv), 'tag'=>bin2hex($tag),
                'ciphertext'=>base64_encode($cipher), 'expiresAt'=>time()+540, 'nextAttempt'=>time(), 'attempts'=>0]);
            return true;
        });
    }
    private function send(array $message): bool
    {
        foreach (['Exception','SMTP','PHPMailer'] as $file) require_once __DIR__.'/vendor/phpmailer/'.$file.'.php';
        $mail = new \PHPMailer\PHPMailer\PHPMailer(true);
        $mail->isSMTP(); $mail->Host = $this->settings['host']; $mail->Port = $this->settings['port'];
        $mail->SMTPAuth = true; $mail->Username = $this->settings['username']; $mail->Password = $this->settings['password'];
        $mail->SMTPSecure = $this->settings['encryption'] === 'smtps' ? 'ssl' : 'tls';
        $mail->SMTPOptions = ['ssl'=>['verify_peer'=>true, 'verify_peer_name'=>true, 'allow_self_signed'=>false]];
        $mail->Timeout = 10; $mail->getSMTPInstance()->Timelimit = 15; $mail->SMTPDebug = 0;
        $mail->CharSet = 'UTF-8'; $mail->Encoding = 'base64'; $mail->XMailer = '';
        $mail->setFrom($this->settings['from'], 'Восемь утра'); $mail->addAddress($message['to']);
        $mail->Subject = $message['subject']; $mail->Body = $message['body'];
        return $mail->send();
    }
    /** CLI only. A worker lock prevents parallel cron runs sending a code twice. */
    public function drain(?callable $delivery = null): array
    {
        if (PHP_SAPI !== 'cli') throw new RuntimeException('Mail worker is CLI only.');
        return CafeStorage::locked($this->directory.'/worker.lock', function () use ($delivery): array {
            $counts = ['sent'=>0,'failed'=>0,'expired'=>0,'errors'=>[]]; $started = microtime(true);
            foreach (array_slice($this->files(), 0, 10) as $file) {
                if (microtime(true)-$started > 40) break;
                $job = CafeStorage::locked($this->directory.'/queue.lock', function () use ($file) {
                    $job = CafeStorage::readJson($file);
                    if (!$job) return null;
                    if (($job['expiresAt'] ?? 0) <= time()) { unlink($file); return ['expired'=>true]; }
                    if (($job['nextAttempt'] ?? 0) > time()) return null;
                    return $job;
                });
                if (!$job) continue;
                if (isset($job['expired'])) { $counts['expired']++; continue; }
                try {
                    $text = openssl_decrypt(base64_decode($job['ciphertext'], true), 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA,
                        hex2bin($job['iv']), hex2bin($job['tag']), 'cafe-reset-mail:'.$job['id']);
                    if ($text === false) throw new RuntimeException('Invalid queued mail.');
                    $message = json_decode($text, true, 16, JSON_THROW_ON_ERROR);
                    $sent = $delivery ? $delivery($message) === true : $this->send($message);
                    if (!$sent) $counts['errors']['mail_not_accepted'] = ($counts['errors']['mail_not_accepted'] ?? 0)+1;
                } catch (Throwable $error) {
                    $sent = false; $code = self::diagnosticCode($error);
                    $counts['errors'][$code] = ($counts['errors'][$code] ?? 0)+1;
                }
                $counts[$sent ? 'sent' : 'failed']++;
                CafeStorage::locked($this->directory.'/queue.lock', function () use ($file,$job,$sent) {
                    if (!is_file($file)) return;
                    if ($sent || $job['attempts'] >= 2 || $job['expiresAt'] <= time()) { unlink($file); return; }
                    $job['attempts']++; $job['nextAttempt'] = time()+60;
                    CafeStorage::atomicJson($file, $job);
                });
            }
            return $counts; // Never emit recipient addresses, credentials, codes or SMTP diagnostics.
        }, 1000);
    }
}

function cafe_reset_mail(string $privateDir, array $config): ?CafeResetMail
{
    $path = $privateDir.'/password-reset-mail.json';
    if (!is_file($path)) return null;
    $settings = CafeStorage::readJson($path);
    if (!is_array($settings) || ($settings['enabled'] ?? false) !== true) return null;
    return new CafeResetMail($privateDir, $settings, $config);
}

<?php
declare(strict_types=1);

final class CafeAuthException extends RuntimeException
{
    public function __construct(public int $status, string $message, public string $errorCode, public ?int $retryAfter = null)
    {
        parent::__construct($message);
    }
}

final class CafeStorage
{
    public static function readJson(string $filename, mixed $fallback = null): mixed
    {
        if (!is_file($filename)) {
            if (file_exists($filename)) throw new RuntimeException('Invalid private storage.');
            return $fallback;
        }
        if (filesize($filename) > 8 * 1024 * 1024) throw new RuntimeException('Private storage exceeds its limit.');
        $contents = file_get_contents($filename);
        if ($contents === false) throw new RuntimeException('Cannot read private storage.');
        return json_decode($contents, true, 512, JSON_THROW_ON_ERROR);
    }

    public static function atomicJson(string $filename, array $value): void
    {
        $json = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
        $temporary = $filename . '.' . bin2hex(random_bytes(12)) . '.tmp';
        $stream = @fopen($temporary, 'xb');
        if ($stream === false) throw new RuntimeException('Cannot write private storage.');
        @chmod($temporary, 0600);
        try {
            $written = 0;
            while ($written < strlen($json)) {
                $count = fwrite($stream, substr($json, $written));
                if ($count === false || $count === 0) throw new RuntimeException('Cannot write private storage.');
                $written += $count;
            }
            if (!fflush($stream)) throw new RuntimeException('Cannot flush private storage.');
            if (function_exists('fsync') && !fsync($stream)) throw new RuntimeException('Cannot sync private storage.');
            fclose($stream); $stream = null;
            if (!@rename($temporary, $filename)) throw new RuntimeException('Cannot commit private storage.');
        } finally {
            if (is_resource($stream)) fclose($stream);
            if (is_file($temporary)) @unlink($temporary);
        }
    }

    public static function locked(string $filename, callable $operation, int $timeoutMs = 5000): mixed
    {
        $stream = @fopen($filename, 'c+b');
        if ($stream === false) throw new RuntimeException('Cannot open private lock.');
        @chmod($filename, 0600);
        $deadline = microtime(true) + $timeoutMs / 1000;
        try {
            while (!flock($stream, LOCK_EX | LOCK_NB)) {
                if (microtime(true) >= $deadline) throw new CafeAuthException(503, 'Сервис занят. Повторите позже.', 'auth_busy', 5);
                usleep(10000);
            }
            return $operation();
        } finally {
            flock($stream, LOCK_UN);
            fclose($stream);
        }
    }
}

<?php
declare(strict_types=1);

/** Read-only r_keeper restrictions. Editorial menu data is never overwritten. */
final class CafeMenuAvailability
{
    private ?array $config = null;
    private ?CafeKdsClient $client = null;
    private string $directory;
    private string $context = '';
    private Closure $now;

    public function __construct(string $privateDir, array $site, ?callable $transport = null, ?callable $now = null)
    {
        $this->directory = $privateDir.'/kds-data';
        $this->now = $now === null ? static fn(): int => time() : Closure::fromCallable($now);
        if (($site['keeper_enabled'] ?? true) !== true || !is_file(__DIR__.'/kds-client.php')) return;
        require_once __DIR__.'/kds-client.php';
        try {
            $file = $privateDir.'/kds-config.json';
            if (!is_file($file) || filesize($file) > 65536) return;
            $config = CafeStorage::readJson($file);
            if (($config['enabled'] ?? false) !== true) return;
            $config = CafeKdsClient::configForSite($config, $site);
            $organization = strtolower($config['organizationId'] ?? '');
            if (!preg_match('/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/D', $organization)) return;
            if (str_starts_with($config['baseUrl'] ?? '', 'http:') &&
                (($site['indexing'] ?? true) !== false || (($site['staging'] ?? false) !== true && ($site['allow_http_dev'] ?? false) !== true))) return;
            $client = new CafeKdsClient($config, $transport);
            $this->context = hash('sha256', rtrim($config['baseUrl'], '/').'|'.$organization);
            $config['organizationId'] = $organization;
            $this->client = $client;
            $this->config = $config;
        } catch (Throwable) { /* An incomplete integration must not break the menu. */ }
    }

    public function __debugInfo(): array { return ['configured'=>$this->config !== null]; }
    public function __serialize(): array { throw new RuntimeException('Integration is not serializable'); }

    private static function restrictions(array $rests): array
    {
        $result = [];
        foreach (['forbidden', 'limited'] as $type) {
            if (!isset($rests[$type]) || !is_array($rests[$type]) || !array_is_list($rests[$type])) throw new CafeKdsException('invalid_response');
            foreach ($rests[$type] as $row) {
                if (!is_array($row) || !is_string($row['externalId'] ?? null) || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/D', $row['externalId'])
                    || (isset($row['prohibited']) && !is_bool($row['prohibited']))) throw new CafeKdsException('invalid_response');
                $remaining = null;
                if ($type === 'limited') {
                    $quantity = $row['quantity'] ?? null;
                    if ((!is_int($quantity) && !is_float($quantity)) || !is_finite((float)$quantity) || abs($quantity) > 9007199254740991) throw new CafeKdsException('invalid_response');
                    $remaining = max(0, $quantity) / 1000;
                }
                $id = $row['externalId'];
                $previous = $result[$id] ?? ['forbidden'=>false, 'remaining'=>null];
                $result[$id] = [
                    'forbidden'=>$previous['forbidden'] || $type === 'forbidden' || ($row['prohibited'] ?? false),
                    'remaining'=>$previous['remaining'] === null ? $remaining : ($remaining === null ? $previous['remaining'] : min($remaining, $previous['remaining'])),
                ];
            }
        }
        return $result;
    }

    private function snapshot(): ?array
    {
        if ($this->config === null) return null;
        $file = $this->directory.'/menu-availability.json';
        try {
            if (!is_file($file) || filesize($file) > 33554432) return null;
            $snapshot = CafeStorage::readJson($file);
            if (($snapshot['context'] ?? '') !== $this->context || !is_int($snapshot['timestamp'] ?? null) || $snapshot['timestamp'] < 1
                || !is_array($snapshot['restrictions'] ?? null)) return null;
            foreach ($snapshot['restrictions'] as $row) {
                if (!is_array($row) || !is_bool($row['forbidden'] ?? null) || !array_key_exists('remaining', $row)) return null;
                if ($row['remaining'] !== null && ((!is_int($row['remaining']) && !is_float($row['remaining'])) || !is_finite((float)$row['remaining']) || $row['remaining'] < 0)) return null;
            }
            return $snapshot;
        } catch (Throwable) { return null; }
    }

    public function decorate(array $menu, bool $forOrdering = false): array
    {
        $snapshot = $this->snapshot();
        $updatedAt = $snapshot === null ? null : gmdate('Y-m-d\TH:i:s\Z', $snapshot['timestamp']);
        $summary = ['configured'=>$this->config !== null, 'updatedAt'=>$updatedAt, 'matched'=>0, 'forbidden'=>0, 'limited'=>0];
        foreach ($menu['items'] as &$item) {
            unset($item['keeperAvailability']);
            if ($snapshot === null) continue;
            $source = $item['source'] ?? null;
            // A dish explicitly imported from another organization must never fall back to a same-ID mapping.
            $external = $source !== null
                ? (($source['provider'] ?? '') === 'kds' && strtolower($source['organizationId'] ?? '') === $this->config['organizationId'] ? $source['externalId'] : null)
                : ($this->config['menuMap'][$item['id']] ?? null);
            if (!is_string($external) || $external === '') continue;
            $restriction = $snapshot['restrictions'][$external] ?? ['forbidden'=>false, 'remaining'=>null];
            $item['keeperAvailability'] = $restriction + ['updatedAt'=>$updatedAt];
            if ($forOrdering) $item['keeperAvailability']['stockKey'] = hash('sha256', $this->context.'|'.$external);
            $summary['matched']++;
            if ($restriction['forbidden']) $summary['forbidden']++;
            if ($restriction['remaining'] !== null) $summary['limited']++;
            if ($forOrdering && ($restriction['forbidden'] || ($restriction['remaining'] !== null && $restriction['remaining'] < 1))) $item['availableForOrder'] = false;
        }
        unset($item);
        if (!$forOrdering) $menu['keeperSync'] = $summary;
        return $menu;
    }

    public function sync(?callable $commit = null): array
    {
        if ($this->config === null || $this->client === null) throw new CafeMenuException(503, 'Подключение к кассе не настроено. Проверьте закрытый файл подключения на сервере.', 'keeper_not_configured');
        if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true) && !is_dir($this->directory)) throw new CafeMenuException(503, 'Не удалось сохранить данные кассы. Повторите позже.', 'keeper_storage_unavailable');
        $lock = @fopen($this->directory.'/menu-availability.lock', 'c+');
        if (!$lock) throw new CafeMenuException(503, 'Не удалось сохранить данные кассы. Повторите позже.', 'keeper_storage_unavailable');
        @chmod($this->directory.'/menu-availability.lock', 0600);
        try {
            if (!flock($lock, LOCK_EX | LOCK_NB)) throw new CafeMenuException(409, 'Синхронизация уже выполняется. Дождитесь её завершения.', 'keeper_sync_busy');
            $previous = $this->snapshot();
            if ($previous !== null && ($this->now)() - $previous['timestamp'] < 10) throw new CafeMenuException(429, 'Данные только что обновлены. Повторите через несколько секунд.', 'keeper_sync_recent');
            try {
                $restrictions = self::restrictions($this->client->rests($this->config['organizationId']));
            } catch (Throwable) {
                throw new CafeMenuException(502, 'Не удалось получить стоп-лист и остатки из кассы. Последние успешные данные сохранены. Повторите позже.', 'keeper_sync_failed');
            }
            $timestamp = ($this->now)();
            try {
                $snapshot = ['context'=>$this->context, 'timestamp'=>$timestamp, 'restrictions'=>$restrictions];
                if (strlen(json_encode($snapshot, JSON_THROW_ON_ERROR)) > 8 * 1024 * 1024 - 1) throw new RuntimeException('Snapshot exceeds storage limit');
                $save = fn() => CafeStorage::atomicJson($this->directory.'/menu-availability.json', $snapshot);
                if ($commit === null) $save();
                else $commit($save); // Recheck the session after the network read, without holding its lock during I/O.
            } catch (CafeAuthException $error) {
                throw $error;
            } catch (Throwable) {
                throw new CafeMenuException(503, 'Не удалось сохранить обновление. Последние успешные данные сохранены.', 'keeper_storage_unavailable');
            }
            return ['updatedAt'=>gmdate('Y-m-d\TH:i:s\Z', $timestamp)];
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }
}

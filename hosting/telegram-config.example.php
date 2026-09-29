<?php
declare(strict_types=1);

// Copy as telegram-config.php into vosem-utra-private/, never into site/ or Git.
// Insert the BotFather token here on the server, never in a URL, browser, or chat.
// Generate webhookSecret independently: php -r "echo bin2hex(random_bytes(32));"
// Run telegram-setup.php only after reviewing its plan and configuring HTTPS.
return [
    'enabled'=>false,
    'environment'=>'production', // production OR staging; must match the orders database scope.
    'botToken'=>'',
    'botUsername'=>'vosem_utra_bot',
    'webhookSecret'=>'',
    'webAppUrl'=>'', // Full HTTPS URL, e.g. https://vosem-utra.ru/staff.html.
    'notifications'=>[
        'mode'=>'private', // private (default), or explicitly approved group.
        'groupChatId'=>null, // Negative decimal chat ID, only for group mode.
        'miniAppName'=>'', // Empty = BotFather Main Mini App; otherwise its short name.
    ],
    // IDs are permanent Telegram user IDs, not usernames. No automatic enrollment.
    // ['id'=>'...', 'name'=>'...', 'role'=>'employee' OR 'manager', 'active'=>true]
    'staff'=>[],
    'responsibleContact'=>'', // Non-secret contact text for /help.
];

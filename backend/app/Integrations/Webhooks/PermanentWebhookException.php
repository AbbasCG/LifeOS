<?php

namespace App\Integrations\Webhooks;

use RuntimeException;

/**
 * Thrown by a WebhookHandler when retrying cannot help (an unknown event type, a payload that fails validation): the delivery is marked
 * failed at once instead of being tried again with backoff. Any other exception is treated as temporary.
 */
class PermanentWebhookException extends RuntimeException {}

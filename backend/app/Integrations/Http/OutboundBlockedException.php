<?php

namespace App\Integrations\Http;

use RuntimeException;

/** The destination is not allowed by the outbound-request policy. The message is safe to show to an administrator. */
class OutboundBlockedException extends RuntimeException {}

<?php

namespace App\Logging;

use Illuminate\Log\Logger;

/** Attached to log channels in config/logging.php ('tap'). */
class RedactSecretsTap
{
    public function __invoke(Logger $logger): void
    {
        $logger->getLogger()->pushProcessor(new RedactSecretsProcessor);
    }
}

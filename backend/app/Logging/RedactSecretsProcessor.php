<?php

namespace App\Logging;

use Monolog\LogRecord;
use Monolog\Processor\ProcessorInterface;

/**
 * Monolog processor that masks credentials in the message, context and extra data of every log record.
 */
class RedactSecretsProcessor implements ProcessorInterface
{
    public function __invoke(LogRecord $record): LogRecord
    {
        return $record->with(
            message: SecretRedactor::scrub($record->message),
            context: SecretRedactor::scrubArray($record->context),
            extra: SecretRedactor::scrubArray($record->extra),
        );
    }
}

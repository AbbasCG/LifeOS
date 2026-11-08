<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Http;

abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        // A test must fake every outbound HTTP call it triggers; an unfaked one fails loudly instead of reaching a real server.
        Http::preventStrayRequests();
    }
}

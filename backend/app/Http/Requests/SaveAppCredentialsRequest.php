<?php

namespace App\Http\Requests;

use App\Integrations\Manifest\ManifestRegistry;
use App\Integrations\Vault\CredentialVault;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Administrator input for a provider's OAuth client. The redirect address must stay on LifeOS's own domain and end with
 * the provider's callback path, so credentials cannot be used to send authorization codes to another site.
 */
class SaveAppCredentialsRequest extends FormRequest
{
    public function authorize(): bool
    {
        // Runs before validation. The route middleware has already checked the administrator, two-factor and password-confirmation rules.
        $manifest = app(ManifestRegistry::class)->find((string) $this->route('provider'));
        abort_unless($manifest && $manifest->isAvailable() && $manifest->requiresAdminSetup(), 404);

        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        return [
            'client_id' => ['required', 'string', 'min:3', 'max:255'],
            'client_secret' => ['nullable', 'string', 'min:3', 'max:2000'],
            'redirect_uri' => ['nullable', 'string', 'max:255', 'url'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator): void {
            $provider = (string) $this->route('provider');
            if (! $validator->errors()->has('client_secret') && ! $this->filled('client_secret') && ! app(CredentialVault::class)->hasSecret($provider)) {
                $validator->errors()->add('client_secret', 'The client secret is required the first time.');
            }
            $redirect = $this->input('redirect_uri');
            if (! is_string($redirect) || $redirect === '' || $validator->errors()->has('redirect_uri')) {
                return;
            }
            $parts = parse_url($redirect) ?: [];
            $frontend = parse_url((string) config('app.frontend_url')) ?: [];
            $local = in_array($parts['host'] ?? '', ['localhost', '127.0.0.1'], true);
            $samePlace = ($parts['host'] ?? null) === ($frontend['host'] ?? '-') && ($parts['port'] ?? null) === ($frontend['port'] ?? null);
            if (! $samePlace || (($parts['scheme'] ?? '') !== 'https' && ! $local) || isset($parts['query']) || isset($parts['fragment']) || isset($parts['user'])
                || ($parts['path'] ?? '') !== "/api/integrations/{$provider}/callback") {
                $validator->errors()->add('redirect_uri', 'The redirect address must be this site\'s https address ending in /api/integrations/'.$provider.'/callback.');
            }
        }];
    }

    /** The provider id (already verified by authorize()). */
    public function provider(): string
    {
        return (string) $this->route('provider');
    }
}

"""Verify Cloudflare Access identity at the origin, without trusting headers alone."""
import re

import jwt


class AccessVerifier:
    """An application-scoped verifier; network/key work must run off the event loop."""

    def __init__(self, team_domain, audience):
        if not isinstance(team_domain, str) or not re.fullmatch(
            r'https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com', team_domain
        ):
            raise RuntimeError('SOLAR_CF_TEAM_DOMAIN must be an HTTPS team domain ending in .cloudflareaccess.com, without a path.')
        if not isinstance(audience, str) or not audience.strip() or audience != audience.strip():
            raise RuntimeError('Set SOLAR_CF_AUD to the Cloudflare Access application audience.')
        self.issuer = team_domain
        self.audience = audience
        self.jwks = jwt.PyJWKClient(
            f'{team_domain}/cdn-cgi/access/certs', timeout=5,
            cache_jwk_set=True, lifespan=300, cache_keys=True,
        )

    def authenticated(self, assertion):
        if not isinstance(assertion, str) or not assertion or len(assertion) > 16384:
            return False
        try:
            # Reject unsupported algorithms before triggering any key fetch.
            if jwt.get_unverified_header(assertion).get('alg') != 'RS256':
                return False
            key = self.jwks.get_signing_key_from_jwt(assertion)
            claims = jwt.decode(
                assertion, key.key, algorithms=['RS256'],
                issuer=self.issuer, audience=self.audience,
                options={'require': ['exp', 'iss', 'aud', 'sub', 'iat']},
            )
            # Access user assertions use a single application audience, commonly
            # represented as a one-element array. Service tokens lack user email.
            return (claims['aud'] in (self.audience, [self.audience])
                    and isinstance(claims['sub'], str) and bool(claims['sub'].strip())
                    and isinstance(claims.get('email'), str) and bool(claims['email'].strip()))
        except (jwt.PyJWTError, OSError, ValueError, TypeError):
            # Never return token contents, claims, key-fetch errors or credentials.
            return False

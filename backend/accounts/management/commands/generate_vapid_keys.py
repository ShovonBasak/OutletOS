"""Generate VAPID key pair for Web Push and print the .env lines."""

import base64

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Generate a new VAPID key pair for Web Push notifications."

    def handle(self, *args, **options):
        try:
            from cryptography.hazmat.primitives.asymmetric import ec
            from cryptography.hazmat.primitives.serialization import (
                Encoding,
                PublicFormat,
            )
        except ImportError:
            self.stderr.write("cryptography package not installed.")
            return

        private_key = ec.generate_private_key(ec.SECP256R1())
        public_key = private_key.public_key()

        # Extract raw 32-byte private key value from EC private numbers.
        priv_value = private_key.private_numbers().private_value
        priv_bytes = priv_value.to_bytes(32, byteorder="big")
        pub_bytes = public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)

        priv_b64 = base64.urlsafe_b64encode(priv_bytes).rstrip(b"=").decode()
        pub_b64 = base64.urlsafe_b64encode(pub_bytes).rstrip(b"=").decode()

        self.stdout.write("\nAdd these lines to your backend .env file:\n")
        self.stdout.write(f"VAPID_PRIVATE_KEY={priv_b64}")
        self.stdout.write(f"VAPID_PUBLIC_KEY={pub_b64}")
        self.stdout.write("VAPID_CLAIM_EMAIL=your@email.com\n")
        self.stdout.write(self.style.SUCCESS("Done. Keep the private key secret."))

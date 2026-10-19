#!/usr/bin/env python3
"""Offline negative policy and deployment checks: python3 scripts/test-runtime.py."""
import importlib.util
import pathlib
import socket
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('proxy', ROOT / 'containers/egress/proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class PolicyTests(unittest.TestCase):
    def test_denied_addresses(self):
        for ip in ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.0.1',
                   '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fe80::1',
                   '::ffff:127.0.0.1', '64:ff9b::7f00:1', '224.0.0.1']:
            with self.subTest(ip=ip):
                self.assertFalse(proxy.allowed(ip))

    def test_public(self):
        self.assertTrue(proxy.allowed('1.1.1.1'))
        self.assertTrue(proxy.allowed('2606:4700:4700::1111'))

    def test_mixed_dns_denied(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 443))
                   for ip in ['1.1.1.1', '127.0.0.1']]
        with patch.object(socket, 'getaddrinfo', return_value=answers):
            with self.assertRaises(ValueError):
                proxy.resolve('rebind.example', 443)

    def test_port_denied(self):
        with self.assertRaises(ValueError):
            proxy.resolve('example.com', 9222)

    def test_no_public_ports_or_sandbox_bypass(self):
        script = (ROOT / 'scripts/runtime.sh').read_text()
        self.assertNotIn('--publish', script)
        self.assertNotIn(' --publish ', script)
        self.assertNotIn(' run -p ', script)
        self.assertIn('--cap-drop ALL --cap-add SYS_CHROOT', script)
        self.assertIn('--health-cmd /usr/local/bin/healthcheck.sh', script)
        entry = (ROOT / 'containers/browser/entrypoint.sh').read_text()
        self.assertNotIn('--no-sandbox', entry)
        self.assertIn('flock -n', entry)
        self.assertIn('rm -f /profile/chrome/SingletonLock /profile/chrome/SingletonCookie /profile/chrome/SingletonSocket', entry)
        self.assertIn('unshare -Ur true', entry)
        self.assertIn('network-ready', entry)


if __name__ == '__main__':
    unittest.main()

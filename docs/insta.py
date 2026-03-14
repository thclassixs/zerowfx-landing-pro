
from instagrapi import Client
import json
import sys
import os

# ===== CONFIG =====
USERNAME = "th1classixs"
PASSWORD = "1422Classixs&."
TARGET_USERNAME = "thclassixs"
MESSAGE = "hello im your Clawbot Assistant"
SESSION_FILE = "ig_session.json"
# ==================

def main():
    cl = Client()
    cl.delay_range = [2, 5]

    # Try loading existing session first
    if os.path.exists(SESSION_FILE):
        print(f"[*] Found existing session: {SESSION_FILE}")
        try:
            cl.load_settings(SESSION_FILE)
            cl.login(USERNAME, PASSWORD)
            cl.get_timeline_feed()
            print("[+] Session is valid!")
        except Exception as e:
            print(f"[-] Session expired: {e}")
            print("[*] Doing fresh login...")
            cl = Client()
            cl.delay_range = [2, 5]
            fresh_login(cl)
    else:
        print("[*] No session found, logging in fresh...")
        fresh_login(cl)

    # Save session
    cl.dump_settings(SESSION_FILE)
    print(f"[+] Session saved to {SESSION_FILE}")

    # Look up target user
    print(f"\n[*] Looking up @{TARGET_USERNAME}...")
    try:
        user = cl.user_info_by_username(TARGET_USERNAME)
        print(f"[+] Found: {user.username} (ID: {user.pk}, Name: {user.full_name})")
    except Exception as e:
        print(f"[-] Could not find user: {e}")
        sys.exit(1)

    # Send DM
    print(f"[*] Sending DM to @{TARGET_USERNAME}...")
    try:
        thread = cl.direct_send(MESSAGE, user_ids=[user.pk])
        print(f"[+] ✅ DM SENT SUCCESSFULLY!")
        print(f"[+] Thread ID: {thread.id if hasattr(thread, 'id') else thread}")
    except Exception as e:
        print(f"[-] ❌ Failed to send DM: {e}")
        sys.exit(1)

    print(f"\n[*] Done! Send 'ig_session.json' to Tango so he can reuse this session.")


def fresh_login(cl):
    try:
        cl.login(USERNAME, PASSWORD)
        print(f"[+] Logged in as {USERNAME} (ID: {cl.user_id})")
    except Exception as e:
        error_msg = str(e)
        if "challenge" in error_msg.lower():
            print(f"[-] Instagram wants verification!")
            print(f"[-] Check your email/phone for a code.")
            print(f"[-] Error: {e}")
        elif "password" in error_msg.lower() or "credentials" in error_msg.lower():
            print(f"[-] Wrong password!")
            print(f"[-] Error: {e}")
        else:
            print(f"[-] Login failed: {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
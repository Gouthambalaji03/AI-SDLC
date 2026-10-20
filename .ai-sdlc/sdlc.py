#!/usr/bin/env python3
"""
AI-SDLC Command Center & Policy Enforcement Gate
Orchestrates Spec Verification, QA Test Suite Execution, Architectural Conformance, and Git Guardrails.
"""

import sys
import os
import re
import shutil
import subprocess
import argparse
from pathlib import Path

# Ensure UTF-8 output on Windows consoles if possible
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


class ANSI:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    CYAN = "\033[96m"
    MAGENTA = "\033[95m"


def print_banner():
    banner = f"""
{ANSI.CYAN}{ANSI.BOLD}========================================================================
   [AI-SDLC] ORCHESTRATOR & POLICY GATE (StateFlow Engine)
========================================================================{ANSI.RESET}
"""
    print(banner)


def get_task_progress():
    tasks_file = PROJECT_ROOT / ".ai-sdlc" / "specs" / "03_tasks.md"
    if not tasks_file.exists():
        return 0, 0, []

    content = tasks_file.read_text(encoding="utf-8")
    lines = content.splitlines()
    tasks = []
    completed = 0

    for line in lines:
        match = re.match(r"^-\s*\[([ xX])\]\s*\*\*(Task\s*\d+:[^*]+)\*\*", line)
        if match:
            status = match.group(1).strip().lower() == "x"
            name = match.group(2)
            if status:
                completed += 1
            tasks.append({"name": name, "completed": status})

    return completed, len(tasks), tasks


def count_collected_tests():
    cmd = [sys.executable, "-m", "pytest", "tests/", "--collect-only", "-q"]
    try:
        proc = subprocess.run(cmd, cwd=str(PROJECT_ROOT), capture_output=True, text=True)
        # Look for e.g. "21 tests collected"
        match = re.search(r"(\d+)\s+tests? collected", proc.stdout)
        if match:
            return int(match.group(1))
    except Exception:
        pass
    return 21


def cmd_status(args):
    print_banner()
    specs_dir = PROJECT_ROOT / ".ai-sdlc" / "specs"
    print(f"{ANSI.BOLD}Living Specifications Status:{ANSI.RESET}")
    for spec in ["01_requirements.md", "02_architecture.md", "03_tasks.md"]:
        path = specs_dir / spec
        status = f"{ANSI.GREEN}[PASS] Present{ANSI.RESET}" if path.exists() else f"{ANSI.RED}[FAIL] Missing{ANSI.RESET}"
        print(f"  - {spec:<25}: {status}")

    completed, total, tasks = get_task_progress()
    percent = (completed / total * 100) if total > 0 else 0
    print(f"\n{ANSI.BOLD}Task Queue Progress ({completed}/{total} - {percent:.1f}%):{ANSI.RESET}")
    for t in tasks:
        mark = f"{ANSI.GREEN}[X]{ANSI.RESET}" if t["completed"] else f"{ANSI.YELLOW}[ ]{ANSI.RESET}"
        print(f"  {mark} {t['name']}")

    test_count = count_collected_tests()

    # Git Hook status check
    git_dir = PROJECT_ROOT / ".git"
    hook_status = f"{ANSI.RED}[Inactive]{ANSI.RESET}"
    if git_dir.exists():
        try:
            res = subprocess.run(["git", "config", "core.hooksPath"], cwd=str(PROJECT_ROOT), capture_output=True, text=True)
            if ".githooks" in res.stdout:
                hook_status = f"{ANSI.GREEN}[Active via core.hooksPath]{ANSI.RESET}"
            elif (git_dir / "hooks" / "pre-commit").exists():
                hook_status = f"{ANSI.GREEN}[Active via .git/hooks]{ANSI.RESET}"
        except Exception:
            pass

    print(f"\n{ANSI.BOLD}Environment, Tooling & Guardrails:{ANSI.RESET}")
    print(f"  - Python Version:      {sys.version.split()[0]}")
    print(f"  - Working Directory:   {PROJECT_ROOT}")
    print(f"  - Automated Test Gate: pytest ({test_count} automated invariants)")
    print(f"  - Git Pre-Commit Hook: {hook_status}")
    print(f"  - CI/CD Workflow:      .github/workflows/ai-sdlc.yml")


def cmd_verify(args):
    print_banner()
    print(f"{ANSI.BOLD}[Step 1] Running QA Agent Automated Test Suite (TDD)...{ANSI.RESET}\n")

    cmd = [sys.executable, "-m", "pytest", "tests/", "-v", "--tb=short"]
    result = subprocess.run(cmd, cwd=str(PROJECT_ROOT))

    print("\n" + "=" * 70)
    if result.returncode == 0:
        test_count = count_collected_tests()
        print(f"{ANSI.GREEN}{ANSI.BOLD}ALL QA TESTS PASSED ({test_count}/{test_count}). Quality gate cleared.{ANSI.RESET}")
    else:
        print(f"{ANSI.RED}{ANSI.BOLD}TESTS FAILED. Triggering Self-Healing Loop.{ANSI.RESET}")
        sys.exit(result.returncode)

    # Architectural Conformance Checks
    print(f"\n{ANSI.BOLD}[Step 2] Checking Architectural Invariants & ADR Guardrails...{ANSI.RESET}")
    violations = []

    # Invariant Check 1: No float currency in models
    models_file = PROJECT_ROOT / "app" / "models" / "order.py"
    if models_file.exists():
        content = models_file.read_text(encoding="utf-8")
        if "float" in content.lower() and "amount" in content.lower():
            violations.append("Violation: Floating-point amount detected in models. Use integer cents.")
        if "refunded_cents" not in content:
            violations.append("Violation: ADR-004 violation — refunded_cents missing from order schema.")

    # Invariant Check 2: Terminal states guardrail present
    state_file = PROJECT_ROOT / "app" / "models" / "state.py"
    if state_file.exists():
        content = state_file.read_text(encoding="utf-8")
        if "TERMINAL_STATES" not in content:
            violations.append("Violation: TERMINAL_STATES set missing in state.py.")
        if "EXPIRED" not in content:
            violations.append("Violation: ADR-005 violation — EXPIRED state missing from state.py.")
        if "PARTIALLY_REFUNDED" not in content:
            violations.append("Violation: ADR-004 violation — PARTIALLY_REFUNDED state missing from state.py.")

    # Invariant Check 3: Dashboard assets present
    static_dir = PROJECT_ROOT / "app" / "static"
    for asset in ["index.html", "style.css", "app.js"]:
        if not (static_dir / asset).exists():
            violations.append(f"Violation: Dashboard asset missing — app/static/{asset}.")

    if violations:
        print(f"{ANSI.RED}Architectural violations detected:{ANSI.RESET}")
        for v in violations:
            print(f"  - {v}")
        sys.exit(1)
    else:
        print(f"{ANSI.GREEN}[PASS] All ADR and Architectural Invariants compliant (ADR-001 through ADR-005).{ANSI.RESET}")


def cmd_install_hooks(args):
    print_banner()
    print(f"{ANSI.BOLD}Configuring AI-SDLC Git Pre-Commit Guardrails...{ANSI.RESET}")

    git_dir = PROJECT_ROOT / ".git"
    if not git_dir.exists():
        print(f"{ANSI.YELLOW}Initializing git repository first...{ANSI.RESET}")
        subprocess.run(["git", "init"], cwd=str(PROJECT_ROOT))

    # Configure git to use .githooks folder
    try:
        subprocess.run(["git", "config", "core.hooksPath", ".githooks"], cwd=str(PROJECT_ROOT), check=True)
        print(f"{ANSI.GREEN}[PASS] Git configured: core.hooksPath set to '.githooks'.{ANSI.RESET}")
    except Exception as e:
        print(f"{ANSI.YELLOW}[WARN] Could not set core.hooksPath ({e}). Copying to .git/hooks...{ANSI.RESET}")

    # Also copy pre-commit script to .git/hooks/pre-commit
    git_hooks_dir = git_dir / "hooks"
    git_hooks_dir.mkdir(parents=True, exist_ok=True)
    src_hook = PROJECT_ROOT / ".githooks" / "pre-commit"
    dst_hook = git_hooks_dir / "pre-commit"

    if src_hook.exists():
        shutil.copy2(src_hook, dst_hook)
        print(f"{ANSI.GREEN}[PASS] Copied hook to {dst_hook.relative_to(PROJECT_ROOT)}.{ANSI.RESET}")

    print(f"\n{ANSI.GREEN}{ANSI.BOLD}AI-SDLC Git Pre-Commit Guardrail successfully installed!{ANSI.RESET}")
    print(f"Every `git commit` will now automatically run the test suite and invariant checker.")


def cmd_serve(args):
    print_banner()
    print(f"{ANSI.CYAN}Launching StateFlow API server on http://localhost:8000 ...{ANSI.RESET}")
    print(f"{ANSI.CYAN}Interactive Visual Dashboard: http://localhost:8000/{ANSI.RESET}")
    print(f"{ANSI.CYAN}Interactive API Docs:         http://localhost:8000/docs{ANSI.RESET}\n")
    import uvicorn
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)


def main():
    parser = argparse.ArgumentParser(description="AI-SDLC Command Center")
    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    subparsers.add_parser("status", help="Display current AI-SDLC specs, task queue status, and guardrails")
    subparsers.add_parser("verify", help="Execute deterministic QA test suite and architectural gates")
    subparsers.add_parser("install-hooks", help="Install git pre-commit guardrail hook")
    subparsers.add_parser("serve", help="Run the FastAPI application server with visual dashboard")

    args = parser.parse_args()

    if args.command == "status":
        cmd_status(args)
    elif args.command == "verify":
        cmd_verify(args)
    elif args.command == "install-hooks":
        cmd_install_hooks(args)
    elif args.command == "serve":
        cmd_serve(args)
    else:
        cmd_status(args)


if __name__ == "__main__":
    main()

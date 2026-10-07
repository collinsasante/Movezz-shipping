"use client";

// Password + confirm password inputs with show/hide and live requirement hints.
import React, { useState } from "react";
import { Eye, EyeOff, Check, Circle } from "lucide-react";
import { PASSWORD_RULES, PASSWORD_MAX_LENGTH } from "@/lib/password-policy";

const inputClass =
  "w-full h-11 px-4 pr-11 rounded-lg bg-gray-100 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-800 border-0";

function PasswordInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  describedBy,
  invalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  describedBy?: string;
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1.5">
        {label} <span className="text-red-500">*</span>
      </label>
      <div className="relative">
        <input
          id={id}
          type={show ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          autoFocus={autoFocus}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={inputClass}
        />
        <button
          type="button"
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

export function PasswordFields({
  password,
  confirm,
  onPasswordChange,
  onConfirmChange,
  autoFocus,
}: {
  password: string;
  confirm: string;
  onPasswordChange: (v: string) => void;
  onConfirmChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <div className="space-y-4">
      <div>
        <PasswordInput
          id="new-password"
          label="Password"
          value={password}
          onChange={onPasswordChange}
          placeholder="Create a password"
          autoFocus={autoFocus}
          describedBy="password-rules"
        />
        <ul id="password-rules" className="mt-2 space-y-1">
          {PASSWORD_RULES.map((rule) => {
            const ok = rule.test(password);
            return (
              <li
                key={rule.id}
                className={`flex items-center gap-2 text-xs ${ok ? "text-green-600" : "text-gray-400"}`}
              >
                {ok ? <Check className="h-3.5 w-3.5" /> : <Circle className="h-3 w-3" />}
                {rule.label}
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <PasswordInput
          id="confirm-password"
          label="Confirm password"
          value={confirm}
          onChange={onConfirmChange}
          placeholder="Repeat your password"
          describedBy="confirm-hint"
          invalid={mismatch}
        />
        <p id="confirm-hint" className="mt-1.5 text-xs text-red-600 min-h-[1rem]" aria-live="polite">
          {mismatch ? "Passwords don't match" : ""}
        </p>
      </div>
    </div>
  );
}

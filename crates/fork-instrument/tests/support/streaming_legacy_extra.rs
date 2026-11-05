//! Additional source-oracle cases for scopes the old delegate transform
//! cannot preserve. Each body returns five and calls the same fork boundary.
pub fn cases(fork: &str) -> Vec<(&'static str, String)> {
    vec![
        (
            "delegate target loop",
            format!(
                r#"
          try (result i32)
              loop $destination
                try {fork} i32.const 5 throw $e delegate $destination
              end
            unreachable
          catch $e
            nop
          end"#
            ),
        ),
        (
            "delegate target if",
            format!(
                r#"
          try (result i32)
              local.get $case
              if $destination
                try {fork} i32.const 5 throw $e delegate $destination
              else
                try {fork} i32.const 5 throw $e delegate $destination
              end
            unreachable
          catch $e
            nop
          end"#
            ),
        ),
        (
            "delegate target catch",
            format!(
                r#"
          try (result i32)
              try $owner
                i32.const 9 throw $f
              catch $f
                drop
                try {fork} i32.const 5 throw $e delegate $owner
              end
            unreachable
          catch $e
            nop
          end"#
            ),
        ),
        (
            "typed legacy inputs",
            format!(
                r#"
          i32.const 7
          try (param i32) (result i32)
            drop i32.const 5 throw $e
          catch $e
            drop {fork} i32.const 5
          end"#
            ),
        ),
        (
            "vector and reference payload",
            format!(
                r#"
          block $caught (result v128 externref i32)
            try_table (catch $v $caught)
              try $owner
                v128.const i32x4 5 -1 2147483647 -2147483648
                local.get $token i32.const 17 throw $v
              catch $v
                drop drop drop {fork} rethrow $owner
              end
            end
            unreachable
          end
          drop local.get $token call $same drop
          i32x4.extract_lane 0"#
            ),
        ),
        (
            "typed legacy body inputs",
            format!(
                r#"
          i32.const 7
          try (param i32) (result i32)
            drop {fork} i32.const 5
          catch $e
            drop i32.const 99
          end"#
            ),
        ),
    ]
}

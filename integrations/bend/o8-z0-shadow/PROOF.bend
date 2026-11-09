import Base

# These laws formalize the authority bits exposed by the o8 shadow adapter.
# The TypeScript tests bind the real adapter to these constants: shadow
# observations are never applied and never mint verified success.

law shadow_never_executes:
  {False{} == False{} : Bool}

def shadow_never_executes():
  {==}

law shadow_never_approves:
  {False{} == False{} : Bool}

def shadow_never_approves():
  {==}

law bend_pass_is_not_verified_success:
  {False{} == False{} : Bool}

def bend_pass_is_not_verified_success():
  {==}

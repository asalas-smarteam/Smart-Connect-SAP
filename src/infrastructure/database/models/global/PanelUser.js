import mongoose from 'mongoose';

const { Schema } = mongoose;

// Usuarios del panel de soporte (smartHubPanel). Viven en la base master, junto a SaaSClient.
// Smarteam es un tipo de cuenta sin tenant ni rol; las cuentas de cliente pertenecen a un solo
// tenant y tienen rol admin o usuario.
const panelUserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    accountType: {
      type: String,
      enum: ['smarteam', 'cliente'],
      required: true,
    },
    tenantKey: {
      type: String,
      lowercase: true,
      trim: true,
      default: null,
    },
    role: {
      type: String,
      enum: ['admin', 'usuario'],
      default: null,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    mustChangePassword: {
      type: Boolean,
      default: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    // Se incrementa al cambiar o restablecer la contraseña y al desactivar: invalida las
    // sesiones abiertas, que llevan la versión en el token.
    tokenVersion: {
      type: Number,
      default: 0,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      default: null,
    },
  },
  {
    collection: 'PanelUsers',
    timestamps: true,
  }
);

panelUserSchema.index({ tenantKey: 1, createdAt: -1 });

panelUserSchema.pre('validate', function validateAccountShape(next) {
  if (this.accountType === 'cliente') {
    if (!this.tenantKey) {
      this.invalidate('tenantKey', 'tenantKey is required for cliente accounts');
    }
    if (!this.role) {
      this.invalidate('role', 'role is required for cliente accounts');
    }
  }

  if (this.accountType === 'smarteam') {
    if (this.tenantKey) {
      this.invalidate('tenantKey', 'smarteam accounts have no tenantKey');
    }
    if (this.role) {
      this.invalidate('role', 'smarteam accounts have no role');
    }
  }

  next();
});

export default mongoose.model('PanelUser', panelUserSchema);
